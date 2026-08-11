---
schema: 1
engine: vllm
primaryName: "--interleave-mm-strings"
title: "--interleave-mm-strings"
summary: Ставит placeholder'ы медиа в промпт там, где они шли в сообщении, а не сваливает их в начало. Работает только при `--chat-template-content-format string` и конфликтует с промптами, где placeholder'ы расставлены вручную.
group: MultiModalConfig
related:
  - --chat-template-content-format
  - --chat-template
  - --limit-mm-per-prompt
  - --enable-mm-embeds
---

# --interleave-mm-strings

## Кратко

При строковом формате контента chat-шаблона vLLM склеивает части сообщения в один текст. По умолчанию placeholder'ы (`<|image_pad|>` и аналоги) приписываются **в начало** получившегося промпта, а текстовые части соединяются переводами строк. С этим флагом порядок сохраняется: текст, картинка, текст, картинка — так, как их прислал клиент.

Это единственный флаг группы `MultiModalConfig`, который вообще не касается памяти: он меняет только форму итоговой строки промпта. Зато он заметно влияет на качество на задачах, где важна привязка «этот вопрос — к этой картинке».

Парный флаг — `--no-interleave-mm-strings`.

## Оригинальная справка

```text
Enable fully interleaved support for multimodal prompts, while using
--chat-template-content-format=string.
```

## Паспорт аргумента

- Флаги: `--interleave-mm-strings`, `--no-interleave-mm-strings`
- Группа argparse: `MultiModalConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: `True` / `False`
- Значение по умолчанию: `False`
- Эффективное значение: применяется только когда фактический `content_format` равен `"string"`; при `openai`-формате (список частей) значение не читается вовсе
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.interleave_mm_strings`
- Этап применения: разбор chat-сообщений в API-процессе, до препроцессинга медиа

## Что меняет в движке

`parse_chat_messages` и `parse_chat_messages_async` (`vllm/entrypoints/chat_utils.py`) вычисляют флаг для каждого сообщения как конъюнкцию трёх условий:

```python
interleave_strings=(
    content_format == "string"
    and model_config.multimodal_config is not None
    and model_config.multimodal_config.interleave_mm_strings
)
```

Дальше он доезжает до `_get_full_multimodal_text_prompt`:

- при `interleave_strings=True` текст собирается через `_get_interleaved_text_prompt(placeholder_storage, texts)` — placeholder'ы встают на свои места между текстовыми частями;
- иначе текстовые части просто соединяются `"\n"`, а недостающие placeholder'ы приписываются **спереди** через `multimodal_content_part_separator`.

В обоих режимах затем выполняется сверка: сколько placeholder'ов уже есть в тексте и сколько медиа-элементов пришло. Если в тексте их оказалось больше, чем данных, движок пишет `Placeholder count is negative! Ensure that the 'interleave_strings' flag is disabled (current value: %s) when manually placing image placeholders.` и отклоняет запрос с `Found more '<placeholder>' placeholders in input prompt than actual multimodal data items.`

Обратите внимание, что интерлив выполняется до сверки намеренно — на случай, когда клиент сам расставил placeholder'ы, а флаг забыли выключить.

## Значения и формат

- Флага нет — `False`: placeholder'ы спереди. Дефолт.
- `--interleave-mm-strings` — `True`.
- `--no-interleave-mm-strings` — явный `False`.
- Значение бессмысленно, если `--chat-template-content-format` разрешился в `openai`: там части сообщения и так остаются списком, и порядок сохраняется chat-шаблоном.
- Формат контента разрешается автоматически по chat-шаблону модели, если не задан явно, поэтому «работает или нет» стоит проверять вместе с `--chat-template-content-format`.

## Когда использовать

- Многокартиночные диалоги, где к каждому изображению относится свой кусок текста («сравни эти два графика: [img1] за первый квартал, [img2] за второй»). Со сваленными в начало placeholder'ами модель теряет привязку.
- Модели, чей chat-шаблон разрешается в строковый формат и которые обучались на интерливленных промптах.
- Не включайте, если клиенты сами вставляют placeholder'ы в текст: получите отказ по несовпадению количества.
- Не включайте «на всякий случай» на однокартиночном трафике: разницы нет, а поведение при ошибках клиента становится строже.

## Влияние на производительность и память

- **Память.** Не влияет: меняется только порядок символов в промпте, число placeholder-токенов то же самое.
- **Latency/throughput.** Не влияет: сборка строки происходит в API-процессе и стоит доли миллисекунды.
- **Prefix caching.** Косвенный эффект: другой порядок частей означает другой префикс, поэтому переключение флага обнуляет попадания в prefix cache для ранее виденных диалогов.
- **Качество.** Единственная величина, ради которой флаг существует.

## Взаимодействие с другими аргументами

- `--chat-template-content-format`: обязательное условие. При `openai` флаг не читается; при `string` — работает. Значение `auto` разрешается по шаблону модели, поэтому эффект флага зависит от того, во что оно разрешилось.
- `--chat-template`: сам шаблон определяет, как выглядит итоговый промпт вокруг placeholder'ов и в какой формат разрешится `auto`.
- `--limit-mm-per-prompt`: считает элементы; сверка количества placeholder'ов выполняется независимо и даёт своё сообщение.
- `--enable-mm-embeds`: эмбеддинги проходят тот же путь сборки промпта, поэтому флаг действует и на них.

## Типовые проблемы и диагностика

- **Симптом:** `Found more '<|image_pad|>' placeholders in input prompt than actual multimodal data items.` **Причина:** клиент вставил placeholder'ы вручную, а флаг добавил свои. **Проверка:** рядом в логе строка `Placeholder count is negative! Ensure that the 'interleave_strings' flag is disabled (current value: True) ...` **Лечение:** `--no-interleave-mm-strings` либо убрать ручные placeholder'ы из запросов.
- **Симптом:** флаг включён, порядок не изменился. **Причина:** формат контента разрешился в `openai`. **Лечение:** задать `--chat-template-content-format string` явно — но сначала убедитесь, что шаблон модели с ним работает корректно.
- **Симптом:** после включения флага просел prefix cache hit rate. **Причина:** изменился префикс промпта. **Действие:** разовый эффект, проходит по мере прогрева кэша.
- **Симптом:** качество на многокартиночных задачах не улучшилось. **Причина:** модель могла обучаться на промптах с placeholder'ами в начале. **Действие:** сравнить оба режима на своей выборке.
- **Подтверждение принятого значения:** стартовая строка конфига содержит `interleave_mm_strings=True`; практическая проверка — форма итогового промпта при включённом логировании запросов (`--enable-log-requests`).

## Примеры

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --interleave-mm-strings --chat-template-content-format string --limit-mm-per-prompt '{"image": 4}'
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --no-interleave-mm-strings --chat-template-content-format string
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/entrypoints/chat_utils.py`
- `vllm/docs/features/multimodal_inputs.md`
