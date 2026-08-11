---
schema: 1
engine: sglang
primaryName: "--speculative-draft-model-revision"
title: "--speculative-draft-model-revision"
summary: Ветка, тег или commit id draft-модели — отдельная от `--revision` целевой модели. Как только задан `--speculative-draft-model-path`, незаполненное значение автоматически становится `main`, поэтому «не задан» здесь означает «main», а не «как у target'а».
group: spec
related:
  - --speculative-draft-model-path
  - --speculative-algorithm
  - --revision
  - --download-dir
  - --speculative-draft-load-format
  - --speculative-draft-model-quantization
---

# --speculative-draft-model-revision

## Кратко

Пин версии draft-чекпоинта. Нужен ровно там же, где `--revision` для основной модели: когда draft тянется из Hugging Face по repo id и вам нужна воспроизводимость. Ключевая деталь — авто-подстановка `main`: она происходит в самом начале `handle_speculative_decoding`, поэтому «оставить пустым» не значит «взять ревизию target'а».

## Оригинальная справка

```text
The specific draft model version to use. It can be a branch name, a tag name, or a commit id. If unspecified, will use the default version.
```

## Паспорт аргумента

- Флаги: `--speculative-draft-model-revision`
- Группа: `spec`
- Тип значения: строка (`Optional[str]`) — имя ветки, тег или commit id
- Допустимые значения: не ограничены argparse; проверяет уже huggingface_hub при обращении к репозиторию
- Значение по умолчанию: `null`
- Эффективное значение: `"main"` — подставляется в `handle_speculative_decoding`, если `--speculative-draft-model-path` задан, а ревизия нет. Для MTP-чекпоинтов, где путь draft'а автоматически равен `--model-path`, сюда так же автоматически копируется `--revision` target'а
- Где объявлен: `ServerArgs.speculative_draft_model_revision`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (первое действие `handle_speculative_decoding`) → чтение hf-конфига draft'а → создание `ModelConfig` draft-воркера → загрузка весов

## Что меняет в движке

Значение попадает во все обращения к draft-репозиторию:

- `get_config(...)` при выводе `block_size` для DFLASH, `gamma`/`mask_token_id` для DSPARK и при определении draft-архитектуры в `_resolve_dflash_draft_attention_backend`;
- `ModelConfig.from_server_args(..., model_revision=speculative_draft_model_revision, is_draft_model=True)` — и в `spec_aux_hidden_state.py` (расчёт числа слоёв draft'а для KV-ячейки), и в `TpModelWorker._init_model_config` при создании самого воркера;
- `_handle_modelscope_paths` — при `SGLANG_USE_MODELSCOPE=1` ревизия передаётся в `snapshot_download`, и там же явно раскрывается как `revision or "main"`.

Если путь draft'а — локальный каталог, значение не используется никак: ревизия релевантна только для загрузки из хаба.

## Значения и формат

- Любая строка, которую примет huggingface_hub: `main`, `v1.2`, `refs/pr/3`, полный или сокращённый sha.
- Отсутствие значения при заданном пути = `main`. Отдельного «взять как у target'а» нет; чтобы совпало с `--revision`, задайте его сюда явно.
- Аргумент действует только на draft. `--revision` на draft не влияет (кроме автоподстановки для MTP-чекпоинта, где путь и так равен целевому).
- Несуществующая ревизия не отвергается argparse — падение приходит из huggingface_hub при первом чтении конфига, то есть ещё в `__post_init__`.

## Когда использовать

- Draft задан как HF repo id и сервер должен воспроизводимо перезапускаться: пин на commit id снимает риск «ветку обновили — accept rate упал».
- Нужно временно проверить PR-ветку draft-чекпоинта, не трогая target.
- Не задавать, когда draft — локальный каталог: значение просто не читается, а в логе создаёт ложное впечатление пина.

## Влияние на производительность и память

На память и скорость не влияет: значение определяет только, какие файлы будут скачаны. Косвенно влияет на время старта — смена ревизии означает новое скачивание в кеш.

## Взаимодействие с другими аргументами

- `--speculative-draft-model-path`: без него аргумент бессмыслен (и автоподстановка `main` не срабатывает).
- `--revision`: полностью независим; общий он только там, где путь draft'а унаследован от `--model-path`.
- `--download-dir`: куда кладётся скачанный по этой ревизии чекпоинт (для ModelScope-пути — тот же каталог).
- `--speculative-draft-load-format` / `--speculative-draft-model-quantization`: применяются к файлам именно этой ревизии.
- `--speculative-algorithm`: определяет, читается ли конфиг draft'а вообще.

## Типовые проблемы и диагностика

- `RepositoryNotFoundError` / `RevisionNotFoundError` в самом начале старта — опечатка в ревизии или приватный репозиторий без токена.
- «Задал ревизию, а грузится другое» — проверьте, что путь draft'а действительно repo id: для локального каталога аргумент игнорируется молча.
- «Не задавал ревизию, а в `server_args=` стоит `main`» — это ожидаемая подстановка, а не чужая правка конфигурации.
- Что смотреть: дамп `server_args=` (поле `speculative_draft_model_revision`) и путь кеша huggingface в логах загрузчика.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B --speculative-draft-model-revision main
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --revision main --speculative-algorithm EAGLE3 --speculative-draft-model-path lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B --speculative-draft-model-revision 0f7a5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a --download-dir /models/hf-cache
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/spec_aux_hidden_state.py`
- `sglang/python/sglang/srt/speculative/dspark_components/dspark_config.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
