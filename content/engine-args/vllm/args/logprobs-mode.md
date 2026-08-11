---
schema: 1
engine: vllm
primaryName: "--logprobs-mode"
title: "--logprobs-mode"
summary: Что именно возвращается в `logprobs` — сырые или обработанные значения, логвероятности или логиты. Режимы `processed_*` отключают быстрый FlashInfer-сэмплер на всём инстансе, а не только для запросов с logprobs.
group: ModelConfig
related:
  - --max-logprobs
  - --logits-processors
  - --speculative-config
  - --use-fp64-gumbel
---

# --logprobs-mode

## Кратко

Аргумент выбирает точку съёма значений для полей `logprobs` и `prompt_logprobs`: до применения обработчиков логитов и температуры (`raw_*`) или после (`processed_*`), и в каком виде — логвероятности (`*_logprobs`) или сырые логиты (`*_logits`).

Не считайте это переключателем формата ответа. `processed_*` меняет путь сэмплирования на всём инстансе: FlashInfer-ядро top-k/top-p не умеет отдавать значения после отсечения, поэтому движок откатывается на нативную реализацию для **всех** запросов.

## Оригинальная справка

```text
Indicates the content returned in the logprobs and prompt_logprobs.
Supported mode:
1) raw_logprobs, 2) processed_logprobs, 3) raw_logits, 4) processed_logits.
Raw means the values before applying any logit processors, like bad words.
Processed means the values after applying all processors, including
temperature and top_k/top_p.
Note: for prompt_logprobs, processed_* and raw_* yield identical results
because prompt tokens do not go through sampling processors.
```

## Паспорт аргумента

- Флаги: `--logprobs-mode`
- Группа argparse: `ModelConfig`
- Тип значения: enum (строка)
- Допустимые значения: `raw_logits`, `raw_logprobs`, `processed_logits`, `processed_logprobs` (`LogprobsMode`)
- Значение по умолчанию: `raw_logprobs`
- Эффективное значение: не переопределяется, но при speculative decoding rejection sampler временно подменяет режим на `processed_logits` для target-логитов (`logprobs_mode_override`)
- Где объявлен: `vllm/config/model.py:ModelConfig.logprobs_mode`
- Этап применения: инициализация сэмплера (выбор реализации top-k/top-p) → каждый шаг сэмплирования

## Что меняет в движке

**Съём значений** (`vllm/v1/sample/sampler.py:Sampler.forward`). До любой обработки:

- `raw_logprobs` ⇒ `raw_logprobs = self.compute_logprobs(logits)` (log_softmax по исходным логитам);
- `raw_logits` ⇒ клон логитов, приведённый к float32.

Затем логиты переводятся во float32, прогоняются через `apply_logits_processors` и `sample()`. Если режим `processed_*`, `sample()` возвращает `processed_logprobs`, и они перезаписывают `raw_logprobs`. То есть «processed» — это значения после логит-процессоров, температуры и top-k/top-p, а «logits» против «logprobs» — с log_softmax или без него.

Дальше `gather_logprobs` выбирает top-`max_num_logprobs` плюс сэмплированный токен. Особые случаи `max_num_logprobs`: `None` — только точечные `logprob_token_ids`, `-1` — вся несортированная матрица.

**Побочный эффект на сэмплер** — главное, что нужно знать. `vllm/v1/sample/ops/topk_topp_sampler.py:TopKTopPSampler.__init__`:

```
can_use_flashinfer = logprobs_mode not in PROCESSED_LOGPROBS_MODES and flashinfer_sampler_supported()
self.forward = self.forward_cuda if can_use_flashinfer else self.forward_native
```

с комментарием «FlashInfer doesn't expose post-top-k/top-p logits/logprobs, so it can't be used when the configured mode requires them». Аналогично на ROCm: aiter-сэмплер включается только при не-processed режиме. `PROCESSED_LOGPROBS_MODES` — это `("processed_logits", "processed_logprobs")`.

Решение принимается один раз, по конфигу инстанса, и действует на все запросы — включая те, что вообще не просят `logprobs`.

**Speculative decoding.** `vllm/v1/sample/rejection_sampler.py` держит флаги `is_processed_logprobs_mode` и `is_logits_logprobs_mode` и передаёт сэмплеру `logprobs_mode_override="processed_logits"`, когда режим processed; для не-processed режимов сохраняются «сырые» target-логиты отдельным тензором.

**prompt_logprobs.** Промпт-токены не проходят сэмплирование, поэтому `processed_*` и `raw_*` для них дают одно и то же — ровно как написано в справке.

## Значения и формат

- `raw_logprobs` (дефолт) — логвероятности до обработчиков. Совместимо с ожиданиями клиентов OpenAI-API и не мешает быстрым ядрам.
- `raw_logits` — сырые логиты, без log_softmax. Значения не нормированы, сумма экспонент не равна единице; клиенту, который считает их вероятностями, это сломает арифметику.
- `processed_logprobs` — логвероятности после всех обработчиков, температуры и top-k/top-p. Отсечённые токены получают значение, соответствующее нулевой вероятности.
- `processed_logits` — то же, но без log_softmax.
- Это **серверный** аргумент, не per-request: клиент выбрать режим не может, он лишь просит `logprobs: N`.
- Число возвращаемых значений задаёт `--max-logprobs` и per-request `logprobs`, а не этот флаг.

## Когда использовать

- `processed_*` — когда нужно видеть эффект температуры, `logit_bias`, `min_p`, `stop`-логики или собственного процессора из `--logits-processors`. Без этого режима такие эффекты в API просто не видны.
- `*_logits` — для исследовательских задач, где нужен неотнормированный выход (калибровка, дистилляция).
- `raw_logprobs` — во всех остальных случаях: это дефолт, он не трогает путь сэмплирования и даёт значения, которые ожидает типовой клиент.
- **Не включайте `processed_*` «на всякий случай»** на продовом инстансе: цену платят все запросы, а пользу получают только те, кто читает logprobs.

## Влияние на производительность и память

- **Throughput.** Основная статья — потеря FlashInfer-ядра top-k/top-p (и aiter на ROCm) в режимах `processed_*`. Нативная реализация сортирует/маскирует распределение средствами PyTorch; разница заметна на больших батчах и больших словарях.
- **VRAM.** `raw_*` дополнительно держит клон/логвероятности исходных логитов на шаг: `(num_tokens, vocab_size)` во float32. Для батча 32 и словаря 150k это ~19 MiB на шаг — транзиентно, учитывается профилированием как пик активаций.
- **Сеть и хост.** Объём ответа задаётся `--max-logprobs` и per-request `logprobs`; `-1` в `--max-logprobs` означает всю матрицу `output_length × vocab_size` и способен уронить процесс по памяти — предупреждение об этом есть в справке самого `--max-logprobs`.
- **Время старта.** Не влияет; выбор реализации сэмплера — это одна проверка при инициализации.

## Взаимодействие с другими аргументами

- `--max-logprobs`: верхняя граница числа возвращаемых значений (дефолт 20, `-1` — без ограничения). Ортогонален режиму.
- `--logits-processors`: их эффект виден в ответе только в режимах `processed_*`.
- `--speculative-config`: rejection sampler подменяет режим для target-логитов; сочетание работает, но семантика возвращаемых значений при спекуляции отличается от обычного пути.
- `--use-fp64-gumbel`: соседняя ручка численности сэмплирования; влияет на сам розыгрыш, а не на то, что возвращается.

## Типовые проблемы и диагностика

- **Симптом:** после смены режима на `processed_logprobs` упал throughput, хотя ни один клиент logprobs не запрашивает. **Причина:** отключён FlashInfer-сэмплер для всего инстанса. **Лечение:** вернуть `raw_logprobs`.
- **Симптом:** в логе `FlashInfer top-p/top-k sampling disabled via VLLM_USE_FLASHINFER_SAMPLER=0.` **Причина:** это другая причина того же отката — переменная окружения, не режим. Проверьте обе.
- **Симптом:** значения в `logprobs` положительные или не суммируются в вероятность 1. **Причина:** выбран режим `*_logits`, там нет log_softmax. **Лечение:** `*_logprobs`, если клиент ожидает логвероятности.
- **Симптом:** температура и `logit_bias` не отражаются в возвращаемых logprobs. **Причина:** дефолтный `raw_logprobs` снимает значения до обработки. **Лечение:** `processed_logprobs`.
- **Симптом:** `prompt_logprobs` не меняется при смене режима. **Причина:** штатное поведение — промпт не проходит сэмплирование.
- **Подтверждение принятого значения:** прямой строки нет; проверяется поведением ответа и косвенно — наличием/отсутствием сообщений о FlashInfer-сэмплере в логе старта.

## Примеры

```bash
vllm serve /models/Qwen3-4B --logprobs-mode processed_logprobs --max-logprobs 5
```

```bash
vllm serve /models/Qwen3-4B --logprobs-mode raw_logits --max-logprobs 20 --max-model-len 8192
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/v1/sample/sampler.py`
- `vllm/vllm/v1/sample/ops/topk_topp_sampler.py`
- `vllm/vllm/v1/sample/rejection_sampler.py`
- `vllm/vllm/v1/worker/gpu/sample/sampler.py`
