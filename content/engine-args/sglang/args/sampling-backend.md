---
schema: 1
engine: sglang
primaryName: "--sampling-backend"
title: "--sampling-backend"
summary: Выбирает реализацию top-k / top-p / min-p сэмплирования. Это не только скорость: FlashInfer и PyTorch применяют фильтры по-разному и дают разные распределения, а FlashInfer вообще не поддерживает пер-запросный seed.
group: exec.kernel
related:
  - --enable-deterministic-inference
  - --device
  - --grammar-backend
  - --attention-backend
---

# --sampling-backend

## Кратко

`--sampling-backend` определяет, каким кодом считается выбор следующего токена после softmax. Вариантов по факту два практических — `flashinfer` (ядра `flashinfer.sampling` + `sgl_kernel`) и `pytorch` (сортировка и маскирование средствами torch), плюс `ascend` для NPU. По умолчанию берется `flashinfer`, если пакет доступен. Разница между ними не только в скорости: порядок применения top-k/top-p различается, а детерминированный режим и `sampling_seed` работают только на `pytorch`.

## Оригинальная справка

```text
Choose the kernels for sampling layers.
```

## Паспорт аргумента

- Флаги: `--sampling-backend`
- Группа: `exec.kernel`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `flashinfer`, `pytorch`, `ascend`. В исходниках это множество `SAMPLING_BACKEND_CHOICES`, в которое дополнительно попадает `token_oracle` при `SGLANG_KV_CANARY_ENABLE_TOKEN_ORACLE=1`, а внешний код может зарегистрировать свой backend через `register_sampler_backend` (`sglang/python/sglang/srt/layers/sampler.py`). Реальный список для вашей сборки — в `--help`
- Значение по умолчанию: `null` — «подберет движок»
- Эффективное значение: `_sampling_backend_default` (`sglang/python/sglang/srt/arg_groups/overrides.py`) подставляет `flashinfer`, если FlashInfer доступен, иначе `pytorch`. Дальше значение может быть перезаписано: `--device cpu` и `--device hpu` жестко ставят `pytorch` (даже поверх явно заданного значения), а `--enable-deterministic-inference` через `_deterministic_sampling_backend` ставит `pytorch` для всего, кроме `ascend`, с логом `Sampling backend is set to pytorch for deterministic inference.`
- Где объявлен: `ServerArgs.sampling_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; поле помечено `resolvable=True`
- Этап применения: разбор CLI → платформенные обработчики `__post_init__` → `_handle_sampling_backend` → создание `Sampler` в model runner (`create_sampler`) → каждый шаг сэмплирования

## Что меняет в движке

Значение читается в `sglang/python/sglang/srt/layers/sampler.py` и разветвляет `Sampler._sample_from_probs`:

- **`flashinfer`.** При наличии min-p: `top_k_renorm_prob` → `top_p_renorm_prob` → `min_p_sampling_from_probs`. Иначе — `top_k_top_p_sampling_from_probs(..., filter_apply_order="joint")`, то есть top-k и top-p применяются совместно одним ядром. Дополнительно стоит ассерт `Sampling seed is not supported for flashinfer backend`: любой запрос с пер-запросным seed на этом backend'е падает.
- **`pytorch`.** `top_k_top_p_min_p_sampling_from_probs_torch`: полная сортировка вероятностей, обнуление хвоста за top-k, затем за top-p, затем порог min-p, затем `torch.multinomial` (или `multinomial_with_seed`, если задан seed). Медленнее, но поддерживает seed и воспроизводимость.
- **`ascend`.** Отдельная ветка `_forward_ascend_backend`, сэмплирующая прямо из логитов; она же включает возврат sampling-маски в планировщике (`scheduler.py`: `req.return_sampling_mask and … sampling_backend == "ascend"`).
- Любое другое имя: `create_sampler` бросает `Unknown sampling backend '<x>'. Register it via register_sampler_backend().`, а `_sample_from_probs` — `Invalid sampling backend: <x>`.

Важно: путь «greedy» (все запросы с `temperature=0`) и «simple» (нет ни top-k, ни top-p, ни min-p) идут мимо этой развилки — там всегда `torch.argmax` / общая реализация. То есть аргумент влияет только на запросы с активными фильтрами сэмплирования.

## Значения и формат

- `flashinfer` — дефолт на CUDA. На CUDA модуль `sampler.py` импортирует `flashinfer.sampling` безусловно, так что отсутствие пакета проявится не как fallback, а как ошибка импорта.
- `pytorch` — универсальный и единственный, совместимый с детерминированным сэмплированием и с `sampling_seed` в параметрах запроса.
- `ascend` — только для NPU; на CUDA он приведет к вызову несуществующих операций.
- Значение вне `choices` отвергает argparse; строка `token_oracle` принимается только при включенной переменной окружения.

## Когда использовать

- Задавайте `pytorch`, когда нужна воспроизводимость на уровне запроса (пер-запросный seed) или когда вы отлаживаете подозрение на артефакт ядра FlashInfer: разное распределение при одинаковых `top_k`/`top_p` — известное следствие `filter_apply_order="joint"` против последовательного маскирования.
- Не задавайте ничего, если сервер работает в обычном режиме на CUDA: автоподбор возьмет `flashinfer`, а он заметно дешевле по времени на больших батчах.
- Не пытайтесь задать `flashinfer` вместе с `--enable-deterministic-inference`: значение будет молча перетерто на `pytorch`.

## Влияние на производительность и память

- На VRAM влияния практически нет: обе реализации работают на уже выделенном буфере логитов, `pytorch`-путь дополнительно держит отсортированную копию вероятностей размера `batch × vocab` (fp32 — это десятки мегабайт на большом батче и словаре, но не порядок величины KV-пула).
- На latency влияет заметно на больших батчах: полная сортировка словаря в `pytorch`-пути стоит существенно дороже слитого ядра FlashInfer, и эта стоимость приходится на каждый шаг декодирования.
- На время старта не влияет.

## Взаимодействие с другими аргументами

- `--enable-deterministic-inference`: принудительно `pytorch` (кроме `ascend`), плюс отдельная логика логпробов через `log_softmax`.
- `--device`: `cpu` и `hpu` принудительно ставят `pytorch`; `npu` работает с `ascend`.
- `--grammar-backend`: маска грамматики применяется к логитам до сэмплирования, независимо от выбранного backend'а; смена sampling-backend'а не чинит и не ломает structured output.
- `--attention-backend`: не связаны, кроме общего требования к платформе.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: Sampling seed is not supported for flashinfer backend`. **Причина:** запрос с пер-запросным seed на дефолтном backend'е. **Решение:** `--sampling-backend pytorch`.
- **Симптом:** задан `flashinfer`, а в дампе `sampling_backend='pytorch'`. **Причина:** детерминированный режим или `--device cpu`/`hpu`. **Проверка:** warning `Sampling backend is set to pytorch for deterministic inference.`
- **Симптом:** результаты с одинаковыми `top_k`/`top_p` отличаются от другого сервера. **Причина:** разные backend'ы сэмплирования — это ожидаемое расхождение, а не баг.
- **Симптом:** `ValueError: Unknown sampling backend '<x>'`. **Причина:** значение из `choices` расширенной сборки, которое в текущей не зарегистрировано.
- **Проверка:** дамп `server_args=` при старте показывает уже разрешенное значение.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --sampling-backend pytorch
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --sampling-backend flashinfer --grammar-backend xgrammar
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/sampler.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/deterministic_inference.mdx`
