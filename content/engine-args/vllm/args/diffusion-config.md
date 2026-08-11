---
schema: 1
engine: vllm
primaryName: "--diffusion-config"
title: "--diffusion-config"
summary: JSON-объект `DiffusionConfig` из двух полей для дискретных диффузионных языковых моделей (dLLM): длина канвы и максимум шагов расшумления. Узкая интеграция — в реестре моделей ей соответствует одна архитектура, и конфиг обычно создается автоматически из HF-конфига.
group: VllmConfig
related:
  - --speculative-config
  - --max-num-seqs
  - --attention-backend
  - --attention-config
  - --max-model-len
  - --generation-config
---

# --diffusion-config

## Кратко

`--diffusion-config` (алиас `-dc`) заполняет `DiffusionConfig` (`vllm/config/diffusion.py`) — конфигурацию дискретных диффузионных языковых моделей. Такие модели генерируют не слева направо, а итеративным расшумлением блока фиксированной длины («канвы»), переиспользуя при этом тракт спекулятивного декодирования с другой семантикой.

Интеграция узкая: в реестре моделей на снятом коммите ей соответствует одна архитектура — `DiffusionGemmaForBlockDiffusion`. Задавать флаг руками почти никогда не нужно: `DiffusionGemmaModelForBlockDiffusionConfig.verify_and_update_config()` создает конфиг сам из HF-конфига модели.

## Оригинальная справка

```text
Diffusion LLM (dLLM) configuration.
```

## Паспорт аргумента

- Флаги: `--diffusion-config`, `-dc`
- Группа argparse: `VllmConfig`
- Тип значения: JSON-объект (либо точечные под-флаги `-dc.<поле> <значение>`)
- Допустимые значения: поля `canvas_length` и `max_denoising_steps`
- Значение по умолчанию: `None`
- Эффективное значение: JSON **не валидируется на разборе CLI** — `add_cli_args` подменяет тип на `optional_type(json.loads)`, а объект собирается в `EngineArgs.create_diffusion_config()`. Дальше, если конфиг остался `None` и модель диффузионная, он создается автоматически: `canvas_length` берется из атрибута `canvas_length` HF-конфига (по умолчанию `256`), `max_denoising_steps` остается `None` и читается из `generation_config.json` при построении сэмплера. Заодно тот же хук может понизить `--max-num-seqs` до `8`, если пользователь не задал его явно
- Где объявлен: `vllm/config/vllm.py:VllmConfig.diffusion_config`
- Этап применения: разбор CLI → `create_engine_config` → `try_verify_and_update_config` для архитектуры модели → построение сэмплера и планирование шагов расшумления

## Что меняет в движке

| Ключ | По умолчанию | Что делает |
| --- | --- | --- |
| `canvas_length` | `None` (обязателен, строго `> 0`); автоматически — `canvas_length` из HF-конфига, иначе `256` | длина блока-канвы. Одновременно задает число спекулятивных токенов, планируемых на шаг: `VllmConfig.num_speculative_tokens` возвращает `canvas_length`, когда спекуляция не настроена, а модель диффузионная |
| `max_denoising_steps` | `None` | максимум итераций расшумления на один блок. При `None` берется из `generation_config.json` модели |

Диффузионный режим меняет несколько инвариантов движка:

- планировщик считает, что за шаг может не появиться ни одного нового токена (`num_sampled_tokens_per_step = 0`), — обычные модели дают 1;
- метрики спекулятивного декодирования переиспользуются, но печатаются под другими именами: `DiffusionDecoding metrics: Committed token throughput: ..., Mean denoising steps per canvas: ..., Mean tokens committed per denoising step: ...`;
- принудительно включается Model Runner V2 (`use_v2_model_runner` возвращает `True` для диффузионной модели);
- структурированный вывод не поддерживается — запрос отвергается сообщением `Structured outputs are not yet supported for diffusion language models.`;
- FlashInfer исключается из автовыбора backend'а внимания: модель смешивает causal и bidirectional внимание в одном батче, поэтому хук выставляет `attention_config.use_non_causal = True`.

Признак диффузионной модели — `ModelConfig.is_diffusion`, то есть наличие атрибута `canvas_length` в HF-конфиге. Задавать `--diffusion-config` для обычной модели бессмысленно: конфиг попадет в `VllmConfig`, но ни один потребитель его не прочитает.

## Значения и формат

- Обе формы: `--diffusion-config '{"canvas_length":128,"max_denoising_steps":32}'` и `-dc.canvas_length 128`. Точечные под-флаги должны использовать одно написание флага и не смешиваться с полной JSON-строкой.
- Валидация отложена: неизвестный ключ или `canvas_length: 0` дадут ошибку не на разборе CLI, а при сборке конфигурации движка.
- `canvas_length` строго `> 0`; `max_denoising_steps` допускает `None` со смыслом «взять из `generation_config.json`».
- Специальных значений вроде `auto` нет.

## Когда использовать

- **Переопределить длину канвы для dLLM-модели**, когда значение из HF-конфига не устраивает: короче канва — меньше памяти под транзиенты сэмплера и ниже задержка на блок, длиннее — больше токенов за проход.
- **Ограничить `max_denoising_steps`**, если модель тратит слишком много итераций на блок.
- **Не задавайте для обычных авторегрессионных моделей** — эффекта не будет.
- **Не задавайте «на всякий случай» вместе с `--speculative-config`**: оба механизма используют один тракт спекулятивных токенов, и осмысленна ровно одна конфигурация.

## Влияние на производительность и память

- **VRAM.** Главный расход — не сам конфиг, а транзиенты сэмплера: он материализует тензоры `[num_seqs, canvas_length, vocab]` в fp32. Именно поэтому апстрим понижает `--max-num-seqs` до 8 по умолчанию, отмечая в комментарии, что больше восьми последовательностей вызывает OOM даже на H200. Увеличение `canvas_length` умножает этот расход линейно.
- **Latency.** Задержка на блок определяется числом шагов расшумления; `max_denoising_steps` — прямой потолок.
- **Throughput.** Измеряется не токенами на forward, а `Mean tokens committed per denoising step` — сколько позиций канвы фиксируется за шаг.
- **Время старта.** Влияния нет.

## Взаимодействие с другими аргументами

- `--max-num-seqs`: критичен. Если он не задан явно, движок понижает его до 8 именно из-за расхода сэмплера; заданное вручную большое значение никто не понизит.
- `--speculative-config`: тот же тракт спекулятивных токенов; при диффузионной модели `num_speculative_tokens` выводится из `canvas_length`, если спекуляция не настроена.
- `--attention-backend`, `--attention-config`: FlashInfer несовместим со смешанным causal/bidirectional вниманием и отвергается явной ошибкой; движок сам предпочтет `FLASH_ATTN` или `TRITON_ATTN`.
- `--generation-config`: источник `max_denoising_steps` и остальных параметров сэмплинга диффузии при отсутствии явного значения.
- `--max-model-len`: канва — это блок внутри контекста, а не замена ограничению длины.
- `--structured-outputs-config`: структурированный вывод для dLLM не поддерживается.

## Типовые проблемы и диагностика

- **Симптом:** OOM при первых же запросах на dLLM-модели. **Причина:** `--max-num-seqs` задан вручную больше 8, либо увеличена `canvas_length`. **Лечение:** снизить обе величины.
- **Симптом:** `FlashInfer does not support DiffusionGemma's mixed causal/bidirectional attention. Use --attention-backend FLASH_ATTN or TRITON_ATTN instead.` **Лечение:** следовать сообщению или убрать явный backend.
- **Симптом:** `Structured outputs are not yet supported for diffusion language models. Remove the structured output constraint (e.g. 'response_format', 'structured_outputs') from the request.` **Лечение:** убрать ограничение из запроса.
- **Симптом:** ошибка валидации `canvas_length` при сборке конфигурации, хотя argparse значение принял. **Причина:** валидация отложена. **Лечение:** значение должно быть строго положительным целым.
- **Симптом:** флаг задан, но ничего не меняется. **Причина:** модель не диффузионная (`is_diffusion` определяется по атрибуту `canvas_length` в HF-конфиге). **Лечение:** убедиться, что чекпоинт действительно dLLM.
- **Подтверждение принятого значения:** периодическая строка `DiffusionDecoding metrics: Committed token throughput: ..., Mean denoising steps per canvas: ..., Mean tokens committed per denoising step: ...` вместо обычных метрик спекуляции.

## Примеры

```bash
vllm serve /models/diffusion-gemma --diffusion-config '{"canvas_length":128,"max_denoising_steps":32}' --max-num-seqs 4
```

```bash
vllm serve /models/diffusion-gemma -dc.canvas_length 64 --attention-backend TRITON_ATTN
```

## Источники

- `vllm/vllm/config/diffusion.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/config/model.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/model_executor/models/diffusion_gemma.py`
- `vllm/vllm/v1/spec_decode/metrics.py`
