---
schema: 1
engine: vllm
primaryName: "--disable-sliding-window"
title: "--disable-sliding-window"
summary: Отключает скользящее окно внимания модели и одновременно обрезает `max_model_len` до размера этого окна. Обычно применяется как обходной путь для backend'ов, требующих одинакового окна на всех слоях.
group: ModelConfig
related:
  - --max-model-len
  - --attention-backend
  - --kv-cache-dtype
  - --enable-prefix-caching
  - --block-size
---

# --disable-sliding-window

## Кратко

Флаг делает две вещи сразу, и вторая часто оказывается неожиданной: он обнуляет `hf_text_config.sliding_window` (все слои становятся full attention) **и** ограничивает `max_model_len` величиной этого окна.

То есть «отключить скользящее окно» здесь не значит «получить полный контекст обычным вниманием». Это значит «работать только внутри длины окна, но обычным вниманием».

## Оригинальная справка

```text
Whether to disable sliding window. If True, we will disable the sliding
window functionality of the model, capping to sliding window size. If the
model does not support sliding window, this argument is ignored.
```

## Паспорт аргумента

- Флаги: `--disable-sliding-window`, `--no-disable-sliding-window`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: `--disable-sliding-window` ⇒ `True`, `--no-disable-sliding-window` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: принудительно становится `True`, если чекпоинт объявил `sliding_window == 0` — vLLM трактует ноль как «окна нет» и заодно зануляет поле в конфиге, чтобы `max_model_len` не обрезался до нуля
- Где объявлен: `vllm/config/model.py:ModelConfig.disable_sliding_window`
- Этап применения: `ModelConfig.__post_init__` — до и после вычисления `max_model_len`; далее влияет на построение KV-cache spec и на выбор параметров attention-backend'а

## Что меняет в движке

Порядок в `ModelConfig.__post_init__` важен и явно прокомментирован в исходниках.

1. **До вычисления длины.** Если `get_sliding_window() == 0`, движок сам ставит `disable_sliding_window = True` и `hf_text_config.sliding_window = None` — «Some checkpoints set sliding_window to 0 to indicate that sliding window is disabled, but vLLM uses None for that».
2. **Вычисление длины.** `_get_and_verify_max_len(..., disable_sliding_window=..., sliding_window=...)`: при `disable_sliding_window and sliding_window is not None and sliding_window < derived_max_model_len` производный максимум заменяется на размер окна, а `max_len_key` становится `"sliding_window"`. Дальше идут обычные проверки, включая rope-скейлинг и явный `--max-model-len`.
3. **После вычисления длины.** `hf_text_config.sliding_window = None` — комментарий в коде: «Set after get_and_verify_max_len to ensure that max_model_len can be correctly capped to sliding window size».

Дальше `sliding_window is None` расходится по всему движку: слои, которые построили бы `SlidingWindowSpec`, строят `FullAttentionSpec`; `window_left` у всех слоёв становится одинаковым; эвристика cascade attention перестаёт отбраковывать батч по признаку sliding window.

Если у модели окна нет вообще (`get_sliding_window()` возвращает `None`), флаг действительно ни на что не влияет — ровно как сказано в справке.

## Значения и формат

- Булев флаг. «Не задан» = `False` = поведение модели сохраняется.
- Специальных значений нет.
- Флаг не задаёт размер окна и не может его изменить — только выключить. Размер приходит из конфига модели (`sliding_window`).
- Явный `--max-model-len` больше окна при включённом флаге не «отменяет обрезание»: обрезается производная длина, а затем `_get_and_verify_max_len` проверяет заданное значение против неё и падает, если оно больше.

## Когда использовать

- Backend требует одинакового `window_left` на всех слоях. Прямое указание есть в FlashInfer: `ValueError: Window left is not the same for all layers. One potential fix is to set disable_sliding_window=True`. Это основной практический повод.
- Диагностика: подозреваете, что просадка качества на длинном контексте связана с окном, и хотите сравнить с чистым full attention на длине окна.
- **Не используйте, чтобы «получить полный контекст»** — эффект обратный: длина ограничивается окном.
- **Не используйте на гибридных моделях наугад**: там окно бывает частью архитектуры (чередование full/sliding слоёв), и его отключение меняет и раскладку KV-cache, и качество.

## Влияние на производительность и память

- **KV-cache на запрос.** Со скользящим окном менеджер KV-cache освобождает блоки, вышедшие за окно, поэтому запрос удерживает примерно `window` токенов независимо от длины диалога. После отключения окна слои становятся full attention, но одновременно `max_model_len` ≤ `window`, поэтому верхняя граница на запрос остаётся того же порядка. Реальная разница — в том, что блоки больше не освобождаются по ходу декодирования: запрос удерживает всё, что успел накопить, вплоть до `max_model_len`.
- **Concurrency.** Практическое следствие предыдущего пункта: `Maximum concurrency` считается по `max_model_len`, и после отключения окна оценка честнее отражает нагрузку, а не занижает её.
- **Скорость внимания.** Full attention на длине окна дороже sliding-варианта той же длины лишь незначительно — окно и было тем самым ограничением.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--max-model-len`: жёстко связан. При включённом флаге верхняя граница — размер окна модели; больше задать нельзя.
- `--attention-backend`: главный повод включать флаг. FlashInfer требует одинакового окна на слоях; смена backend'а часто решает задачу без обрезания контекста.
- `--enable-prefix-caching`: со скользящим окном попадания ограничены живыми блоками; после отключения окна блоки живут дольше и кэш работает предсказуемее.
- `--kv-cache-dtype`, `--block-size`: определяют байты на страницу; флаг определяет, сколько страниц удерживает запрос.
- `--disable-cascade-attn`: эвристика cascade отказывается работать при sliding window; отключение окна снимает это ограничение (но cascade всё равно нужно разрешить отдельно).

## Типовые проблемы и диагностика

- **Симптом:** после добавления флага сервер отказывается принимать `--max-model-len 32768`, хотя раньше принимал. **Причина:** производный максимум обрезан до размера окна. **Проверка:** строка `Using max model len N` в логе старта — там будет размер окна. **Лечение:** снять флаг либо смириться с длиной окна.
- **Симптом:** `ValueError: Window left is not the same for all layers. One potential fix is to set disable_sliding_window=True` **Причина:** выбран FlashInfer на модели с разнородными окнами. **Лечение:** флаг либо другой backend (`--attention-backend FLASH_ATTN`).
- **Симптом:** флаг задан, но ничего не изменилось. **Причина:** у модели нет `sliding_window` в конфиге — штатное «argument is ignored».
- **Симптом:** модель с `sliding_window: 0` ведёт себя как без окна, хотя флаг не задавался. **Причина:** автоматическое переопределение для такого чекпоинта. **Действие:** ничего.
- **Подтверждение принятого значения:** `Using max model len N` (обрезание) и отсутствие ошибок про `window_left` при старте с FlashInfer.

## Примеры

```bash
vllm serve /models/Ministral-8B-Instruct --disable-sliding-window --attention-backend FLASHINFER
```

```bash
vllm serve /models/Ministral-8B-Instruct --disable-sliding-window --max-model-len 4096 --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/v1/attention/backends/flashinfer.py`
- `vllm/vllm/v1/core/single_type_kv_cache_manager.py`
- `vllm/vllm/v1/core/kv_cache_utils.py`
