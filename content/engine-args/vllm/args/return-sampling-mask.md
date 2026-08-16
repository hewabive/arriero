---
schema: 1
engine: vllm
primaryName: "--return-sampling-mask"
title: "--return-sampling-mask"
summary: Возвращает для каждого сгенерированного токена точный набор token id, переживших обработку логитов и top-k/top-p — «sampling mask» для distribution replay в RL-обучении. Движковый флаг с жесткими предусловиями, глобально отключающий fused-сэмплер FlashInfer.
group: ModelConfig
related:
  - --logprobs-mode
  - --logits-processors
  - --speculative-config
  - --enable-return-routed-experts
---

# --return-sampling-mask

## Кратко

Флаг включает возврат sampling mask — для каждого сгенерированного токена перечисляются token id, оставшиеся с конечными логитами после всей обработки (penalties, logit bias, bad words, температура, min-p, top-k/top-p). Это реализация стратегии «Keep Sampling Mask» из технического отчета DeepSeek-V3.2 (§3.3): при RL-обучении (GRPO и родственные методы) сторона обучения нормализует логиты текущей политики по тому же усеченному множеству, из которого реально сэмплировала старая, — иначе importance ratio считается по разным пространствам действий и обучение дестабилизируется.

Это ручка RL-пайплайна, а не инференс-сервера: в ответах OpenAI-совместимых endpoint'ов маска не появляется вовсе, а плата за включение — отказ от fused-сэмплера FlashInfer для **всех** запросов инстанса.

## Оригинальная справка

```text
Whether to return the post-processing token support for each sample.
```

## Паспорт аргумента

- Флаги: `--return-sampling-mask`, `--no-return-sampling-mask`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг без значения либо парная отрицательная форма
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется, но обвешано предусловиями: `VllmConfig._verify_sampling_replay_config` на старте требует Model Runner V2, отсутствие speculative decoding, diffusion-моделей и кастомных `--logits-processors`, а также `--logprobs-mode processed_logprobs`; каждый запрос дополнительно обязан иметь `temperature > 0` и `top_k > 0`
- Где объявлен: `vllm/config/model.py:ModelConfig.return_sampling_mask`
- Этап применения: старт (валидация конфигурации) → сэмплер каждого шага генерации → сборка финального ответа. Поле входит в `ignored_factors` хеша вычислительного графа, то есть кеш компиляции не инвалидирует

## Что меняет в движке

Три вещи.

1. **Сэмплер** (`vllm/v1/worker/gpu/sample/sampler.py`): конструктор жестко выключает путь FlashInfer — `use_flashinfer = not return_sampling_mask and flashinfer_sampler_supported()`. После сэмплирования шага по обработанным логитам строится маска: Triton-kernel `SamplingMaskTensors.from_logits` (`vllm/v1/worker/gpu/sample/output.py`) упаковывает признак `isfinite(processed_logits)` в битовую матрицу uint8 размером `[num_requests, ceil(vocab_size / 8)]` — токены, обнуленные top-k/top-p до `-inf`, в маску не попадают.
2. **Транспорт**: упакованные маски едут GPU → CPU асинхронно вместе с сэмплированными токенами, планировщик нарезает их по запросам (`SamplingMaskLists`, `vllm/v1/outputs.py`), output processor копит чанки и склеивает их только при завершении запроса.
3. **Ответ**: маска появляется как `CompletionOutput.sampling_mask` (`vllm/outputs.py`) — список списков token id, по одному списку на сгенерированный токен. В стриминге промежуточные чанки маску не несут — только финальный результат.

Наружу маска видна в двух местах: offline API (`LLM(model, return_sampling_mask=True)` → `output.outputs[0].sampling_mask`) и HTTP-endpoint token-in-token-out `/inference/v1/generate` (поле `sampling_mask` в `choices`). Chat Completions и Completions ее не возвращают ни при каком флаге.

## Значения и формат

- Не задан — `false`, масок нет, сэмплер волен использовать FlashInfer.
- `--return-sampling-mask` — включить для инстанса целиком; выбора на уровне запроса нет, платят все.
- `--no-return-sampling-mask` — явно выключить (перебить значение из `--config`-YAML).
- `mask.token_ids[i]` — поддержка распределения, из которого был сэмплирован i-й токен; сторона обучения строит по ней `masked_fill(~keep, -inf)` перед `log_softmax`.

## Когда использовать

- RL-rollout'ы (GRPO и подобные), где обучение считает importance ratio `π_θ/π_old`: маска плюс `--logprobs-mode processed_logprobs` дают обе величины, нормализованные по одному и тому же нуклеусу. Рецепт целиком — апстримный `docs/training/sampling_mask.md`.
- Не включайте на обычном сервисе инференса: масок в OpenAI-ответах все равно нет, а fused-сэмплер выключится для всех запросов.
- Требование `top_k > 0` — не формальность: чистый top-p может оставить нуклеус размером со словарь, и маска раздувается до `vocab_size` id на каждый токен.

## Влияние на производительность и память

- **Throughput/latency.** Главная цена — глобальный отказ от fused-сэмплера FlashInfer: сэмплирование идет по PyTorch-пути даже для запросов, которым маска не нужна. Сверху — Triton-упаковка маски на каждом шаге и дополнительный D2H-трафик.
- **VRAM.** Служебные тензоры маски: `ceil(vocab_size / 8)` байт на запрос на шаг плюс счетчики; при большом словаре и высокой конкурентности это заметный, хотя и не доминирующий, довесок.
- **RAM хоста.** Чанки маски копятся до завершения запроса; длинные генерации с широким нуклеусом дают пропорциональный рост.
- **Время старта** не меняется: вся валидация — быстрые проверки конфигурации.

## Взаимодействие с другими аргументами

- `--logprobs-mode`: обязан быть `processed_logprobs`, иначе старт падает — логи вероятностей должны быть нормализованы по тому же нуклеусу, что и маска.
- `--logits-processors`: несовместим; движковые кастомные процессоры логитов отвергаются на старте.
- `--speculative-config`: несовместим; спекулятивное декодирование отвергается на старте.
- `--enable-return-routed-experts`: соседний «обратный канал» той же механики (возврат маршрутизации MoE-экспертов через `ModelRunnerOutput`); включается независимо.
- Model Runner V2 — требование без собственного CLI-флага: выбирается по архитектуре модели, принудительно включается переменной окружения `VLLM_USE_V2_MODEL_RUNNER=1`.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: sampling distribution replay requires Model Runner V2` при старте. **Причина:** модель по умолчанию обслуживается V1-runner'ом. **Лечение:** `VLLM_USE_V2_MODEL_RUNNER=1`, приняв ограничения V2 для своей конфигурации.
- **Симптом:** `sampling distribution replay does not support speculative decoding` / `... custom logits processors` / `... diffusion models` при старте. **Причина:** несовместимая конфигурация. **Лечение:** убрать конфликтующий механизм или флаг маски.
- **Симптом:** `sampling distribution replay requires logprobs_mode='processed_logprobs' ...` при старте. **Лечение:** добавить `--logprobs-mode processed_logprobs`.
- **Симптом:** запрос отклонен с `sampling distribution replay requires temperature > 0` или `requires top_k > 0 to bound sampling mask size ...`. **Причина:** пер-запросная валидация в input processor — greedy-запрос не имеет усеченного распределения, а без top-k маска не ограничена по размеру. **Лечение:** задать `temperature > 0` и конечный `top_k` в параметрах запроса.
- **Симптом:** в стриминге маски нет. **Причина:** так задумано — маска собирается и отдается только в финальном ответе.
- **Симптом:** в ответах Chat Completions поле не появляется. **Причина:** OpenAI-слой маску не сериализует; она доступна в offline API и на `/inference/v1/generate`.
- Аргумент новый (в дереве с августа 2026): наличие в установленной сборке проверяется через `vllm serve --help` в нужном окружении.

## Примеры

```bash
vllm serve /models/Qwen3-4B --return-sampling-mask --logprobs-mode processed_logprobs
```

```bash
VLLM_USE_V2_MODEL_RUNNER=1 vllm serve /models/Qwen3-4B --return-sampling-mask --logprobs-mode processed_logprobs --gpu-memory-utilization 0.85
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py` (`_verify_sampling_replay_config`)
- `vllm/vllm/v1/engine/input_processor.py`
- `vllm/vllm/v1/worker/gpu/sample/sampler.py`
- `vllm/vllm/v1/worker/gpu/sample/output.py`
- `vllm/vllm/v1/outputs.py`
- `vllm/vllm/outputs.py`
- `vllm/docs/training/sampling_mask.md`
- коммит checkout'а `50ba4bc6b2` «[Feature] Mask Replay (#49577)» — добавил аргумент и весь тракт маски
