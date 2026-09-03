---
schema: 1
engine: vllm
primaryName: "--return-sampling-mask"
title: "--return-sampling-mask"
summary: Возвращает для каждого сэмплированного токена точный support после penalties и sampling-фильтров. Предназначен для корректного distribution replay в RL и требует Model Runner V2 с processed_logprobs.
group: ModelConfig
related:
  - --logprobs-mode
  - --speculative-config
  - --logits-processors
---

# --return-sampling-mask

## Кратко

Флаг сохраняет множество token IDs, оставшихся конечными после всех logit processors и top-k/top-p/min-p фильтрации. RL trainer может нормализовать новую policy на том же support, на котором rollout policy действительно выбирала действие.

## Оригинальная справка

```text
Whether to return the post-processing token support for each sample.
```

## Паспорт аргумента

- Флаги: `--return-sampling-mask`, `--no-return-sampling-mask`
- Группа argparse: `ModelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: положительная/отрицательная форма
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется; при `true` startup-валидация требует Model Runner V2 и `logprobs_mode=processed_logprobs`, а sampler отключает FlashInfer fused path
- Где объявлен: `vllm/config/model.py:ModelConfig.return_sampling_mask`
- Этап применения: валидация `VllmConfig` → sampling на GPU → асинхронная D2H-копия → финальный inference response

## Что меняет в движке

После применения logit bias, penalties, bad words, temperature, min-p, top-k и top-p sampler берёт `torch.isfinite(processed_logits)`. Surviving IDs упаковываются на GPU, асинхронно переносятся на CPU и на завершении собираются в `list[list[int]]`: один список support на каждый сгенерированный токен.

Поле доступно в Python `CompletionOutput` и в финальном ответе `/inference/v1/generate`. OpenAI Chat/Completions его не экспортируют; streaming chunks mask не содержат.

## Значения и формат

- Выключен: sampling output не меняется.
- Включён: каждый запрос обязан иметь `temperature > 0` и `top_k > 0`. `top_k` ограничивает максимальный размер mask и D2H/response overhead.
- Несовместим со speculative decoding, diffusion models и engine-level `--logits-processors`.

## Когда использовать

- Для GRPO/другого RL rollout, где training policy должна воспроизвести усечённое sampling distribution без mismatch в знаменателе importance ratio.
- Не включайте для обычного serving: клиенты OpenAI API не увидят поле, а весь сервер потеряет FlashInfer fused sampler.

## Влияние на производительность и память

Флаг глобально переключает sampling на PyTorch path, строит mask из vocabulary logits и переносит до `top_k` IDs на токен. Это увеличивает GPU compute, host transfer и размер финального ответа; VRAM весов и KV-cache не меняется, но временные sampling buffers растут.

## Взаимодействие с другими аргументами

- `--logprobs-mode processed_logprobs`: обязателен, чтобы logprobs нормализовались по тому же nucleus, что и mask.
- `--speculative-config`: любая speculative decoding конфигурация запрещена.
- `--logits-processors`: пользовательские engine-level processors запрещены, потому что feature не гарантирует воспроизводимость их support.

## Типовые проблемы и диагностика

- **Симптом:** `sampling distribution replay requires Model Runner V2`. **Лечение:** включить/выбрать V2 runner либо снять флаг.
- **Симптом:** ошибка про `logprobs_mode='processed_logprobs'`. **Лечение:** добавить `--logprobs-mode processed_logprobs`.
- **Симптом:** request отвергнут с `temperature > 0` или `top_k > 0`. **Причина:** greedy либо неограниченный top-p support. **Лечение:** задать, например, `temperature=0.8`, `top_k=50`.
- **Симптом:** поля нет в OpenAI response. **Причина:** HTTP-экспорт реализован для `/inference/v1/generate`, не для OpenAI endpoints.

## Примеры

```bash
vllm serve /models/Qwen3-4B --return-sampling-mask --logprobs-mode processed_logprobs
```

```bash
vllm serve /models/Qwen3-4B --no-return-sampling-mask
```

## Источники

- `vllm/vllm/config/model.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/v1/engine/input_processor.py`
- `vllm/vllm/v1/worker/gpu/sample/sampler.py`
- `vllm/vllm/v1/worker/gpu/sample/output.py`
- `vllm/vllm/entrypoints/scale_out/token_in_token_out/protocol.py`
- `vllm/vllm/entrypoints/scale_out/token_in_token_out/serving.py`
- `vllm/docs/training/sampling_mask.md`
