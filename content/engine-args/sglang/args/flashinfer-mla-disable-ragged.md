---
schema: 1
engine: sglang
primaryName: "--flashinfer-mla-disable-ragged"
title: "--flashinfer-mla-disable-ragged"
summary: Запрещает ragged-обертку prefill у FlashInfer MLA. Побочный и более важный эффект — вместе с ней выключается chunked prefix cache и меняется способ диспетчеризации MLA-прохода на DeepSeek-моделях.
group: exec.kernel
related:
  - --attention-backend
  - --prefill-attention-backend
  - --decode-attention-backend
  - --disable-chunked-prefix-cache
  - --chunked-prefill-size
  - --page-size
---

# --flashinfer-mla-disable-ragged

## Кратко

FlashInfer MLA умеет два prefill-пути: ragged (`BatchRagged` поверх неупакованного KV) и paged (`BatchMLAPaged` поверх пула страниц). По умолчанию ragged используется там, где он применим. Флаг его выключает — и заодно выключает chunked prefix cache, потому что тот построен на ragged-обертке. На DeepSeek-моделях он дополнительно перекидывает диспетчер внимания с MHA-пути (одношотового или chunked) на absorbed MLA.

## Оригинальная справка

```text
Not using ragged prefill wrapper when running flashinfer mla
```

## Паспорт аргумента

- Флаги: `--flashinfer-mla-disable-ragged`
- Группа: `exec.kernel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется движком; читается как есть через `get_exec().kernel.flashinfer_mla_disable_ragged`
- Где объявлен: `ServerArgs.flashinfer_mla_disable_ragged`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → конструктор `FlashInferMLAAttnBackend` (решение про chunked KV) → `init_forward_metadata` на каждом prefill → диспетчер внимания DeepSeek на каждом forward

## Что меняет в движке

Три точки чтения, все в рабочем пути.

1. **Chunked prefix cache.** `FlashInferMLAAttnBackend.__init__` (`sglang/python/sglang/srt/layers/attention/flashinfer_mla_backend.py`) вычисляет `enable_chunk_kv` как «не skip_prefill **и** не decode-нода PD-дизагрегации **и** не `--disable-chunked-prefix-cache` **и** не `--flashinfer-mla-disable-ragged`». То есть этот флаг — второй, менее очевидный способ отключить chunked prefix cache, наравне с профильным `--disable-chunked-prefix-cache`.
2. **Выбор обертки на prefill.** В `init_forward_metadata` ragged используется только когда флаг снят, у батча нет префиксов (`extend_no_prefix`) и проход не захватывается в piecewise/breakable CUDA graph. Захваченный prefill в любом случае идет через paged: ragged-обертка отвергает размерности absorbed-MLA (qk=576, vo=512).
3. **Диспетчер DeepSeek.** `sglang/python/sglang/srt/models/deepseek_common/attention_backend_handler.py`: для backend'ов `flashinfer` и `flashmla` флаг выставляет `disable_ragged=True`, и тогда `_handle_attention_backend` никогда не выбирает `MHA_ONE_SHOT` / `MHA_CHUNKED_KV`, а всегда уходит в `_dispatch_mla_subtype` (absorbed MLA). Это меняет арифметику prefill на DeepSeek целиком, а не только обертку.

Заголовочный комментарий самого backend-файла описывает контракт так: при `false` prefill использует пару BatchRagged + BatchMLAPaged, при `true` — только BatchMLAPaged; декод в обоих случаях идет через BatchMLAPaged.

## Значения и формат

- Флаг без аргумента; парной формы `--no-…` нет.
- Значение читается только backend'ами `flashinfer` (в MLA-варианте) и — в части диспетчера DeepSeek — `flashmla`. На не-MLA моделях и на прочих backend'ах оно не делает ничего.
- Отдельного «мягкого» режима нет: либо ragged разрешен там, где применим, либо запрещен везде.

## Когда использовать

- Когда вы столкнулись с ошибкой или неверным результатом именно в ragged-обертке FlashInfer MLA и хотите локализовать проблему, оставшись на том же backend'е.
- Когда нужен воспроизводимый профиль prefill: без ragged все проходы идут одним путем, и сравнение замеров становится честнее.
- Не включайте «на всякий случай» на DeepSeek: вы теряете и chunked prefix cache, и MHA-путь prefill, а это обычно основной источник выигрыша на длинных общих префиксах.
- Не используйте как способ отключить chunked prefix cache — для этого есть `--disable-chunked-prefix-cache`, у которого нет побочных эффектов на выбор обертки.

## Влияние на производительность и память

- **Prefill latency.** Обычно хуже: ragged-обертка существует потому, что на батче без префиксов она дешевле paged-пути.
- **Повторные префиксы.** Заметно хуже на DeepSeek: без chunked prefix cache общий префикс пересчитывается целиком.
- **VRAM.** Прямого эффекта нет; косвенно снимаются буферы chunked-KV, но выигрыш несопоставим с потерей скорости.
- **Время старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--attention-backend flashinfer` (в MLA-варианте) — обязательное условие, чтобы флаг вообще что-то значил; на `flashmla` работает только его половина в диспетчере DeepSeek.
- `--prefill-attention-backend`: если prefill обслуживает не FlashInfer MLA, флаг не читается на этом пути.
- `--disable-chunked-prefix-cache`: перекрывающийся эффект; профильный флаг предпочтительнее.
- `--chunked-prefill-size`: определяет, как режется prefill; вместе с отключенным ragged это меняет и число проходов, и их стоимость.
- CUDA graph для prefill (`--cuda-graph-config`, piecewise/breakable): захваченный prefill и так не использует ragged, так что на таких конфигурациях флаг почти ничего не меняет.

## Типовые проблемы и диагностика

- **Симптом:** после включения флага пропала строка `Chunked prefix cache is turned on.` **Причина:** ожидаемая: флаг гасит `enable_chunk_kv`.
- **Симптом:** на DeepSeek выросло TTFT на длинных промптах с общим префиксом. **Причина:** диспетчер ушел с `MHA_CHUNKED_KV` на absorbed MLA. **Решение:** снять флаг.
- **Симптом:** флаг задан, но ничего не изменилось. **Причина:** backend не FlashInfer MLA (не-MLA модель или другой backend), либо prefill целиком захватывается в CUDA graph.
- **Проверка:** дамп `server_args=` при старте показывает значение флага; наличие/отсутствие строки про chunked prefix cache подтверждает эффект.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --attention-backend flashinfer --flashinfer-mla-disable-ragged
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --attention-backend flashinfer --chunked-prefill-size 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/flashinfer_mla_backend.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_backend_handler.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_forward_methods/forward_mla.py`
- `sglang/docs/docs/advanced_features/attention_backend.mdx`
