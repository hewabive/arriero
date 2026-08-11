---
schema: 1
engine: vllm
primaryName: "--renderer-num-workers"
title: "--renderer-num-workers"
summary: Размер пула потоков во фронтенд-процессе, в котором выполняются токенизация и рендеринг chat-шаблона. Лечит ситуацию, когда узкое место — CPU API-сервера, а не GPU.
group: ModelConfig
related:
  - --tokenizer
  - --tokenizer-mode
  - --mm-processor-cache-gb
  - --runner
  - --max-num-seqs
---

# --renderer-num-workers

## Кратко

`--renderer-num-workers` задает число потоков в `ThreadPoolExecutor` рендерера — той части API-сервера, которая превращает запрос в токены. При одном потоке (дефолт) токенизация длинных промптов сериализуется и становится видимой в TTFT, если конкурентных запросов много.

Аргумент не имеет отношения к GPU: пул живет в процессе API-сервера.

## Оригинальная справка

```text
Number of worker threads in the renderer thread pool. The pool is
consumed by the async renderer path (e.g. the OpenAI-compatible API
server started by `vllm serve`) to parallelize tokenization, chat
template rendering, and multimodal preprocessing across concurrent
requests.

The offline `LLM` entrypoint uses the synchronous renderer path and
processes prompts (including multimodal preprocessing) serially, so
this setting has no effect there.
```

## Паспорт аргумента

- Флаги: `--renderer-num-workers`
- Группа argparse: `ModelConfig`
- Тип значения: int
- Допустимые значения: не ограничены парсером; осмысленны положительные значения
- Значение по умолчанию: `1`
- Эффективное значение: не переопределяется. Для HF-токенизатора создается пул из `N + 1` глубоких копий (`maybe_make_thread_pool(tokenizer, renderer_num_workers + 1)`), поэтому реальное число объектов токенизатора на единицу больше
- Где объявлен: `vllm/config/model.py:ModelConfig.renderer_num_workers`
- Этап применения: инициализация рендерера в процессе API-сервера (`BaseRenderer.__init__`)

## Что меняет в движке

`BaseRenderer.__init__` (`vllm/renderers/base.py`) создает **два** исполнителя:

1. `self._executor = ThreadPoolExecutor(max_workers=renderer_num_workers)` — сюда уходят токенизация промпта (`_tokenize_prompt`), детокенизация и загрузка `prompt_embeds`. `HfRenderer` дополнительно вешает на него асинхронный `apply_chat_template`.
2. `self._mm_executor = ThreadPoolExecutor(max_workers=1)` — мультимодальная предобработка. Он **всегда** односоточный, специально: комментарий в коде ссылается на upstream-issue #38418 (порядок P0/P1) и на то, что токенизация не должна стоять в очереди за мультимодальной обработкой.

То есть аргумент масштабирует именно токенизацию и рендеринг шаблона, а не мультимодальный препроцессинг — вопреки первому впечатлению от текста справки.

`HfRenderer` дополнительно вызывает `maybe_make_thread_pool(tokenizer, N + 1)`: объект `TokenizersBackend` не потокобезопасен, поэтому создается очередь из глубоких копий, и каждый вызов «одалживает» свою. Копия делается только для `TokenizersBackend`; медленный (`use_fast=False`) токенизатор в пул не заворачивается, и параллелизм ему не помогает.

Для офлайнового `LLM` пул не используется вовсе — при `N > 1` печатается предупреждение, что настройка здесь ничего не делает.

## Значения и формат

- `1` — дефолт: весь рендеринг сериализован в одном потоке.
- `N > 1` — пул из `N` потоков плюс `N + 1` копий токенизатора.
- `0` и отрицательные значения парсер пропустит, но `ThreadPoolExecutor` требует положительное число — задавать их бессмысленно.
- Специальных значений (`auto`) нет.

## Когда использовать

- Много одновременных запросов с длинными промптами, GPU недогружен, а профиль показывает, что время уходит на фронтенде. Признак: растет TTFT при низкой утилизации GPU и небольшом числе активных последовательностей.
- Chat-эндпоинт с тяжелым Jinja-шаблоном (много инструментов, длинная история).
- Не поднимайте «про запас»: каждая единица — это лишняя глубокая копия токенизатора в RAM хоста, а на однопоточной нагрузке выигрыша нет.
- Не рассчитывайте ускорить мультимодальную предобработку: у нее собственный односоточный исполнитель.

## Влияние на производительность и память

- **RAM хоста.** Основная цена: `N + 1` глубоких копий объекта токенизатора. Для больших словарей это заметно в RSS процесса API-сервера.
- **CPU.** Пул занимает до `N` потоков одновременно; на хосте с малым числом ядер это конкурирует с самим движком.
- **Latency.** Снижает очередь на токенизацию при конкурентной нагрузке; на одиночном запросе не меняет ничего.
- **VRAM.** Не влияет.
- **Время старта.** Создание копий токенизатора добавляет немного к инициализации фронтенда.

## Взаимодействие с другими аргументами

- `--tokenizer-mode`: пул копий создается только для быстрых HF-токенизаторов; для `slow` он не применяется.
- `--tokenizer`: чем «тяжелее» объект токенизатора, тем дороже каждая копия.
- `--mm-processor-cache-gb`: при `--runner pooling` комбинация `N > 1` и включенного кеша мультимодального процессора запрещена (кеш не потокобезопасен).
- `--runner`: ограничение выше действует именно для pooling-рантайма.
- `--max-num-seqs`: определяет, сколько запросов реально конкурируют за рендерер.

## Типовые проблемы и диагностика

- **Симптом:** `Cannot use --renderer-num-workers > 1 with the multimodal processor cache enabled for pooling models. Pooling preprocessing runs on the renderer workers, and the cache is not thread-safe. Please set --renderer-num-workers 1 (the default), or disable the cache with --mm-processor-cache-gb 0.` **Причина:** сочетание pooling-рантайма, кеша mm-процессора и пула. **Лечение:** одно из двух, как предлагает сообщение.
- **Симптом:** предупреждение `'renderer_num_workers=N' was set, but the offline 'LLM' entrypoint uses the synchronous renderer path…` **Причина:** настройка задана для офлайнового пути. **Лечение:** для `vllm serve` предупреждения не будет; в офлайне аргумент бесполезен.
- **Симптом:** значение поднято, а TTFT не улучшился. **Причина:** узкое место не в токенизации (GPU, планировщик, сеть) либо используется медленный токенизатор, который в пул не заворачивается. **Проверка:** сопоставить утилизацию GPU и число активных последовательностей в периодическом логе.
- **Симптом:** вырос RSS процесса API-сервера. **Причина:** копии токенизатора. **Лечение:** уменьшить значение.

## Примеры

```bash
vllm serve /models/Qwen3-4B --renderer-num-workers 4 --max-num-seqs 16
```

```bash
vllm serve /models/bge-m3 --runner pooling --renderer-num-workers 4 --mm-processor-cache-gb 0
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/renderers/base.py`
- `vllm/vllm/renderers/hf.py`
- `vllm/vllm/tokenizers/hf.py`
- `vllm/vllm/entrypoints/llm.py`
- `vllm/vllm/engine/arg_utils.py`
