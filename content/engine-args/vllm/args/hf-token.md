---
schema: 1
engine: vllm
primaryName: "--hf-token"
title: "--hf-token"
summary: Токен Hugging Face для чтения конфига, токенизатора и метаданных gated-репозитория. Скачивание весов он не покрывает и попадает в командную строку процесса — на управляемом сервере предпочтительнее ambient-токен.
group: ModelConfig
related:
  - --revision
  - --tokenizer-revision
  - --hf-config-path
  - --download-dir
  - --generation-config
---

# --hf-token

## Кратко

`--hf-token` передаётся как `token=` в вызовы `huggingface_hub`, которые делает сам vLLM: резолвинг ревизии, чтение конфига, чтение generation config, метаданные image-процессора.

Два ограничения, из-за которых флаг редко бывает правильным ответом. Во-первых, загрузка весов идёт мимо него: `download_weights_from_hf` вообще не принимает токен и полагается на ambient-аутентификацию `huggingface_hub`. Во-вторых, значение оказывается в командной строке процесса, а в arriero — ещё и в git-версионируемом конфиге инстанса.

## Оригинальная справка

```text
The token to use as HTTP bearer authorization for remote files . If
`True`, will use the token generated when running `hf auth login`
(stored in `~/.cache/huggingface/token`).
```

## Паспорт аргумента

- Флаги: `--hf-token`
- Группа argparse: `ModelConfig`
- Тип значения: `bool | str | None`. Из-за этой тройной union'и `_compute_kwargs` объявляет аргумент как `type=str, nargs="?", const=True`: **голый `--hf-token` без значения даёт `True`** («взять токен из `hf auth login`»), а `--hf-token hf_xxx` — строку
- Допустимые значения: не ограничены
- Значение по умолчанию: `None` — токен не передаётся, `huggingface_hub` разрешает его сам (переменная `HF_TOKEN`, файл `~/.cache/huggingface/token`)
- Эффективное значение: не переопределяется движком
- Где объявлен: `vllm/config/model.py:ModelConfig.hf_token`
- Этап применения: `ModelConfig.__post_init__` и сборка `EngineArgs` — только сетевые обращения к Hub на старте

## Что меняет в движке

Значение прокидывается как `token=`/`hf_token=` в следующие места:

- `resolve_revision(self.model, self.revision, self.hf_token)` и та же функция для токенизатора — разрешение ветки/тега в commit-хеш;
- `get_config(..., token=self.hf_token)` — чтение `config.json` / `params.json`;
- `get_hf_image_processor_config(self.model, hf_token=self.hf_token, revision=self.revision)` — только для мультимодальных моделей;
- `try_get_generation_config(..., hf_token=self.hf_token)`;
- `maybe_override_with_speculators(..., hf_token=self.hf_token)` в `EngineArgs.create_engine_config`;
- отдельные модели (например, `vllm/model_executor/models/minicpmv.py`).

**Чего он не покрывает.** `vllm/model_executor/model_loader/weight_utils.py:download_weights_from_hf` не имеет параметра токена; он использует общий `hf_api()`, созданный как `HfApi(library_name="vllm", library_version=...)` — без явного токена. Значит, аутентификация для скачивания весов берётся из окружения `huggingface_hub`. На gated-репозитории это выглядит так: конфиг прочитался (токен сработал), а `snapshot_download` упал на 401/403.

Практический вывод: для gated-модели задавайте `HF_TOKEN` в окружении инстанса. Тогда `--hf-token` вообще не нужен — `huggingface_hub` подставит тот же токен и в вызовы vLLM.

## Значения и формат

- `--hf-token hf_xxxxxxxx` — явная строка токена.
- `--hf-token` без значения — `True`, то есть «использовать сохранённый локально токен». Это ровно то же, что не задавать флаг вообще, если токен уже лежит в `~/.cache/huggingface/token`.
- Не задан ⇒ `None`, разрешение токена целиком на стороне `huggingface_hub`.
- Значение `None` или пустая строка в качестве аргумента превращаются в `None` (`optional_type`).
- Для локального пути к модели значение бесполезно: сетевых запросов нет.

## Когда использовать

- Разовый запуск, где не хочется настраивать окружение, а репозиторий gated только по метаданным.
- Несколько инстансов на одной машине с разными аккаунтами Hub, и разделить их через окружение почему-то нельзя.
- **Предпочитайте ambient-токен.** `HF_TOKEN` в окружении процесса или `hf auth login` покрывают и вызовы vLLM, и загрузку весов, и не попадают в командную строку.
- **Не храните токен в аргументах инстанса arriero.** Аргументы живут в `config/instances/<name>.json`, а это тот самый каталог, который домен Configuration Git коммитит и умеет клонировать (`docs/CONFIG_GIT.md`). Секреты там не место: для них есть `config/.secrets.json`, который gitignored, но арг-строка инстанса — нет. Задавайте токен переменной окружения инстанса.
- Помните, что командная строка процесса читается любым локальным пользователем через `ps` и `/proc/<pid>/cmdline`; arriero дополнительно снимает с неё launch snapshot для детекта дрейфа конфигурации.

## Влияние на производительность и память

На VRAM, KV-cache и throughput не влияет. На время старта влияет только тем, что успешная аутентификация избавляет от повторных попыток и ошибок при обращении к Hub.

## Взаимодействие с другими аргументами

- `--revision`, `--tokenizer-revision`: токен нужен для резолвинга ревизии приватного репозитория в commit-хеш.
- `--hf-config-path`: конфиг из приватного репозитория читается с этим же токеном.
- `--generation-config auto`: загрузка `generation_config.json` тоже использует токен.
- `--download-dir`: куда лягут скачанные веса; аутентификацию для их скачивания задаёт окружение, не этот флаг.
- Переменные окружения `HF_TOKEN`, `HF_HUB_OFFLINE`: первая — рекомендуемая альтернатива флагу, вторая полностью отключает сетевые обращения и делает токен бессмысленным.

## Типовые проблемы и диагностика

- **Симптом:** конфиг модели прочитался, а скачивание весов падает с 401/403. **Причина:** `--hf-token` не покрывает `download_weights_from_hf`. **Лечение:** `HF_TOKEN` в окружении процесса.
- **Симптом:** `Invalid repository ID or local directory specified: '<model>'` на приватном репозитории. **Причина:** токен не дошёл или не даёт доступа. **Лечение:** проверить токен через `hf auth whoami` в окружении инстанса.
- **Симптом:** `--hf-token` указан без значения и «ничего не изменилось». **Причина:** голый флаг означает `True` — использовать локально сохранённый токен; если его нет, эффекта не будет. **Лечение:** передать строку или выполнить `hf auth login`.
- **Симптом:** токен виден в списке процессов. **Причина:** он в argv. **Лечение:** перейти на переменную окружения; ротировать засветившийся токен.
- **Подтверждение принятого значения:** в стартовой строке конфига (`VllmConfig.__str__`) токена нет — он туда не выводится намеренно. Проверять приходится результатом: успешным чтением конфига приватного репозитория.

## Примеры

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct --hf-token hf_examplekeyvalue --max-model-len 8192
```

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct --hf-token --revision main --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/transformers_utils/config.py`
- `vllm/vllm/transformers_utils/repo_utils.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `docs/CONFIG_GIT.md` (arriero)
