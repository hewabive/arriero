---
schema: 1
engine: vllm
primaryName: "--mm-encoder-attn-backend"
title: "--mm-encoder-attn-backend"
summary: Принудительный выбор backend'а внимания для ViT-энкодера — отдельно от backend'а языковой модели. Список значений реестровый: имена берутся из `AttentionBackendEnum`, а принимается только подмножество, разрешённое платформой.
group: MultiModalConfig
related:
  - --mm-encoder-attn-dtype
  - --mm-encoder-tp-mode
  - --mm-encoder-fp8-scale-path
  - --attention-backend
  - --dtype
  - --compilation-config
---

# --mm-encoder-attn-backend

## Кратко

Обычно backend внимания ViT подбирается автоматически: платформа перебирает свой список кандидатов и берёт первый, который поддерживает нужный `head_size`, `dtype` и compute capability. Флаг заставляет взять конкретный.

Два практических повода: включить FP8-внимание энкодера (для него нужен `FLASHINFER` на CUDA или `ROCM_AITER_FA` на ROCm) и обойти неудачный автовыбор.

Значение — имя члена `AttentionBackendEnum`, регистр не важен (приводится к верхнему). Значений много, применимых к ViT — единицы, и они зависят от платформы.

## Оригинальная справка

```text
Optional override for the multi-modal encoder attention backend when
using vision transformers. Accepts any value from
`vllm.v1.attention.backends.registry.AttentionBackendEnum` (e.g. `FLASH_ATTN`).
```

## Паспорт аргумента

- Флаги: `--mm-encoder-attn-backend`
- Группа argparse: `MultiModalConfig`
- Тип значения: строка — имя члена перечисления
- Допустимые значения: `choices` в extract пусты не потому, что ограничений нет, а потому что список реестровый. Синтаксически принимается любое имя из `AttentionBackendEnum` (`vllm/v1/attention/backends/registry.py`); семантически — только то, что вернёт `current_platform.get_supported_vit_attn_backends()`. На CUDA это `FLASH_ATTN`, `TRITON_ATTN`, `TORCH_SDPA`, `FLASHINFER`; на ROCm — `FLASH_ATTN`, `ROCM_AITER_FA`, `TRITON_ATTN`, `TORCH_SDPA`; на прочих платформах базовый список — только `TORCH_SDPA`
- Значение по умолчанию: `None` — автоподбор платформой
- Эффективное значение: отдельные архитектуры перебивают его в своих hook'ах (`vllm/model_executor/models/config.py`): например Unlimited-OCR принудительно ставит `FLASH_ATTN` и откатывает `FLASHINFER` с предупреждением
- Где объявлен: `vllm/config/multimodal.py:MultiModalConfig.mm_encoder_attn_backend`
- Этап применения: сборка `VllmConfig` (разбор имени) → построение слоёв ViT → forward энкодера

## Что меняет в движке

**Разбор значения.** Валидатор `MultiModalConfig._validate_mm_encoder_attn_backend` принимает строку, `AttentionBackendEnum` или `None`. Строка приводится к верхнему регистру и ищется в перечислении; неизвестное имя даёт `ValueError: Unknown attention backend: '<name>'. Valid options are: <полный список>` — это сообщение и есть самый быстрый способ увидеть актуальный перечень на своей сборке. Отдельно обрабатывается удалённый backend: `Attention backend 'XFORMERS' has been removed (See PR #29262 for details). Please select a supported attention backend.`

**Применение.** `vllm/model_executor/models/vision.py:get_vit_attn_backend()` читает `mm_cfg.mm_encoder_attn_backend` и передаёт его платформе как `attn_backend_override`. `CudaPlatform.get_vit_attn_backend` при непустом override сначала проверяет принадлежность к `get_supported_vit_attn_backends()` (иначе `AssertionError` с текстом `Backend <...> is not supported for vit attention. Supported backends are: [...]`), а затем логирует `Using backend AttentionBackendEnum.FLASHINFER for vit attention`.

**Автоподбор (когда флага нет).** Платформа идёт по своему списку: `TORCH_SDPA` возвращается сразу как универсальный запасной вариант, остальные проверяются на `supports_head_size`, `supports_dtype` и `supports_compute_capability`; `ImportError` при попытке загрузить класс backend'а просто пропускается. В логе так же появляется `Using backend ... for vit attention`.

**Кэш компиляции.** Имя backend'а входит в `MultiModalConfig.compute_hash()` — вместе с `mm_encoder_tp_mode`, `mm_encoder_attn_dtype`, `mm_encoder_fp8_scale_path` и `mm_device_do_normalize`.

## Значения и формат

- Не задан — автоподбор. В большинстве случаев это правильный выбор.
- Имя члена перечисления: `FLASH_ATTN`, `FLASHINFER`, `TRITON_ATTN`, `TORCH_SDPA`, `ROCM_AITER_FA`. Регистр не важен: значение приводится к верхнему.
- `XFORMERS` удалён и даёт явную ошибку со ссылкой на PR.
- Актуальный список для вашей сборки: `python -c "from vllm.v1.attention.backends.registry import AttentionBackendEnum; print([b.name for b in AttentionBackendEnum])"` в окружении движка либо, проще, задать заведомо неверное имя и прочитать список из сообщения об ошибке. Список поддерживаемых **для ViT** смотрите в `get_supported_vit_attn_backends()` соответствующей платформы.
- Флаг относится **только** к ViT-энкодеру. Backend внимания языковой модели — это отдельный аргумент `--attention-backend` (группа `AttentionConfig`), и путать их не стоит.

## Когда использовать

- Обязательно вместе с `--mm-encoder-attn-dtype fp8`: FP8-внимание энкодера реализовано только в `FLASHINFER` (CUDA) и `ROCM_AITER_FA` (ROCm), автоподбор туда не приведёт.
- Когда автоподбор выбрал backend, который на вашей паре «модель + карта» работает медленнее или нестабильно. Сравнивать имеет смысл `FLASH_ATTN` против `FLASHINFER` на Blackwell и новее.
- Диагностика: `TORCH_SDPA` — самый консервативный вариант, годится, чтобы исключить backend из подозреваемых.
- Не задавайте наугад: неподдерживаемое платформой значение роняет старт `AssertionError`, а поддерживаемое, но неудачное, может оказаться медленнее автовыбора.

## Влияние на производительность и память

- **Latency энкодера.** Основная величина. Разница между backend'ами на больших изображениях измеряется десятками процентов; апстрим-замеры FP8 ViT-внимания приведены в `docs/features/quantization/fp8_vit_attn.md`.
- **VRAM.** Разные backend'ы держат разные рабочие буферы; величина невелика по сравнению с весами, но профилирование её учитывает.
- **Совместимость с CUDA graphs.** Динамическое FP8-шкалирование несовместимо с полными CUDA graphs ViT — это ограничение backend-зависимой FP8-ветки, а не самого выбора backend'а.
- **Время старта.** Не меняется заметно; смена значения инвалидирует кэш компиляции графа.

## Взаимодействие с другими аргументами

- `--mm-encoder-attn-dtype`: `fp8` требует конкретного backend'а и падает с явным сообщением на любом другом.
- `--mm-encoder-fp8-scale-path`: часть той же FP8-схемы; входит в тот же хеш компиляции.
- `--mm-encoder-tp-mode`: другая ось оптимизации энкодера; вместе с backend'ом определяет форму вычислений ViT.
- `--dtype`: тип активаций участвует в автоподборе (`supports_dtype`), поэтому смена dtype может изменить выбранный backend.
- `--compilation-config`: `cudagraph_mm_encoder` включает CUDA graphs энкодера; сочетание с FP8-динамикой не поддерживается.

## Типовые проблемы и диагностика

- **Симптом:** `Unknown attention backend: 'flash'. Valid options are: FLASH_ATTN, ...` **Причина:** опечатка в имени. **Лечение:** взять имя из напечатанного списка.
- **Симптом:** `Attention backend 'XFORMERS' has been removed (See PR #29262 for details).` **Причина:** устаревшая конфигурация. **Лечение:** выбрать поддерживаемый backend.
- **Симптом:** `AssertionError: Backend AttentionBackendEnum.FLASHINFER is not supported for vit attention. Supported backends are: [...]` **Причина:** backend есть в перечислении, но платформа не разрешает его для ViT. **Лечение:** взять имя из напечатанного списка поддерживаемых.
- **Симптом:** задали backend, а в логе указан другой. **Причина:** модель-специфичный hook перебил значение (например Unlimited-OCR откатывает `FLASHINFER` в `FLASH_ATTN` с предупреждением). **Проверка:** предупреждение рядом со строкой выбора backend'а.
- **Подтверждение принятого значения:** строка `Using backend AttentionBackendEnum.<NAME> for vit attention` (info, один раз).

## Примеры

```bash
vllm serve /models/Qwen3-VL-8B-Instruct --mm-encoder-attn-backend FLASHINFER --mm-encoder-attn-dtype fp8
```

```bash
vllm serve /models/Qwen2.5-VL-7B-Instruct --mm-encoder-attn-backend FLASH_ATTN --limit-mm-per-prompt '{"image": 2}'
```

## Источники

- `vllm/vllm/config/multimodal.py`
- `vllm/vllm/v1/attention/backends/registry.py`
- `vllm/vllm/model_executor/models/vision.py`
- `vllm/vllm/model_executor/models/config.py`
- `vllm/vllm/platforms/cuda.py`
- `vllm/vllm/platforms/rocm.py`
- `vllm/vllm/platforms/interface.py`
- `vllm/docs/features/quantization/fp8_vit_attn.md`
