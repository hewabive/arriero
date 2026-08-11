---
schema: 1
engine: sglang
primaryName: "--enable-fused-qk-norm-rope"
title: "--enable-fused-qk-norm-rope"
summary: Сливает QK-нормализацию и RoPE в одно JIT-ядро. Реализовано в семействе Qwen3-MoE и в Mellum, только на CUDA, только bf16 и только при head_dim 64/128/256; побочный эффект — отключение fused-записи KV на этом слое.
group: exec.kernel
related:
  - --dtype
  - --attention-backend
  - --json-model-override-args
  - --quantization
---

# --enable-fused-qk-norm-rope

## Кратко

В слое внимания Qwen3-MoE после проекции QKV идут два отдельных шага — RMS-нормализация q и k, затем поворот RoPE. Флаг заменяет их одним слитым JIT-ядром `fused_qk_norm_rope`. Это точечная оптимизация: она включается только там, где реализована (Qwen3-MoE и наследники, Mellum), и только при совпадении набора условий по устройству, dtype и размерности головы. Если хотя бы одно условие не выполнено, слой молча остается на обычном пути.

## Оригинальная справка

```text
Enable fused qk normalization and rope rotary embedding.
```

## Паспорт аргумента

- Флаги: `--enable-fused-qk-norm-rope`
- Группа: `exec.kernel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: `choices` нет
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` его не трогает; фактическое включение решается на уровне слоя при построении модели (см. ниже) и еще раз на каждом forward по dtype тензора QKV
- Где объявлен: `ServerArgs.enable_fused_qk_norm_rope`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: разбор CLI → конструктор слоя внимания при загрузке модели (проверка применимости и прогрев JIT-модуля) → каждый forward

## Что меняет в движке

Поле читают ровно два модуля: `sglang/python/sglang/srt/models/qwen3_moe.py` (класс внимания, наследуемый и другими моделями семейства) и `sglang/python/sglang/srt/models/mellum.py`.

В конструкторе слоя вычисляется `use_fused_qk_norm_rope` — конъюнкция:

- флаг включен;
- `compatible_with_fused_qk_norm_rope`: rotary-эмбеддинг не `MRotaryEmbedding` (то есть не мультимодальный M-RoPE) **и** `head_dim` из `{64, 128, 256}`;
- платформа CUDA;
- `can_use_fused_qk_norm_rope(head_dim, is_neox_style, torch.bfloat16, yarn_factor != 1.0)` — эта функция (`sglang/python/sglang/kernels/ops/attention/fused_qknorm_rope.py`) еще раз проверяет `head_dim`, требует **bfloat16** и пытается собрать JIT-модуль под конкретный вариант (neox-стиль, YaRN); при неудаче пишет warning `Failed to load JIT fused_qk_norm_rope kernel: …` и возвращает `False`.

На forward добавляется последнее условие: `qkv.dtype == torch.bfloat16`.

Важный побочный эффект: когда слитое ядро сработало, слой запоминает это в `_used_fused_qk_norm_rope_last_call`, и в `forward_core` выставляется `save_kv_cache=True` принудительно. То есть оптимизация «fused set kv buffer» (запись v прямо из RoPE-ядра) на этом слое не применяется — KV пишется отдельным шагом. Обычный (не слитый) путь, наоборот, умеет передавать `fused_set_kv_buffer_arg` в rotary-эмбеддинг.

## Значения и формат

- Флаг без аргумента; парной формы нет.
- Включение на неподдерживаемой модели не дает ни ошибки, ни предупреждения — поле просто никто не прочитает.
- Включение на поддерживаемой модели с `--dtype float16` не даст эффекта: `can_use_fused_qk_norm_rope` требует bfloat16 и напишет warning `Unsupported dtype=… for JIT fused_qk_norm_rope kernel`.
- `head_dim` вне `{64, 128, 256}` — warning `Unsupported head_dim=… for JIT fused_qk_norm_rope kernel` и обычный путь.

## Когда использовать

- На Qwen3-MoE (и родственных архитектурах) в bf16 на CUDA, когда вы измеряете декод и хотите убрать два лишних прохода по тензору q/k на каждом слое.
- Не включайте вслепую на мультимодальных вариантах: M-RoPE отсекается проверкой, эффекта не будет.
- Не включайте, если ваш профиль выигрывает от fused-записи KV: слитое ядро ее отключает, и на некоторых конфигурациях чистый выигрыш может оказаться отрицательным. Это тот случай, когда измерять надо обе стороны.

## Влияние на производительность и память

- **Latency декода.** Основной эффект: два ядра (RMSNorm по q/k и RoPE) заменяются одним, экономится чтение-запись промежуточных тензоров.
- **VRAM.** Прямого эффекта нет; косвенно исчезает выгода от fused-записи KV, но объем памяти при этом не меняется.
- **Время старта.** JIT-сборка модуля происходит уже в конструкторе слоя (`can_use_fused_qk_norm_rope` собирает его заранее, чтобы не компилировать на первом реальном вызове) — то есть загрузка модели становится чуть дольше.
- **Точность.** Слитое ядро считает те же операции; заметных расхождений код не документирует, но численный порядок операций отличается от последовательного пути.

## Взаимодействие с другими аргументами

- `--dtype`: обязателен bfloat16, иначе путь не включится.
- `--attention-backend`: не связаны напрямую — ядро работает до вызова внимания. Но отключенная fused-запись KV взаимодействует с тем, как backend читает пул.
- `--quantization`: сама q/k-нормализация и RoPE идут в вычислительном dtype, поэтому квантизация весов флагу не мешает, пока QKV-тензор остается bf16.
- `--json-model-override-args`: через него можно изменить `head_dim`/rope-конфигурацию модели и тем самым выключить применимость ядра.

## Типовые проблемы и диагностика

- **Симптом:** флаг включен, эффекта нет. **Причины по убыванию частоты:** модель не из семейства Qwen3-MoE/Mellum; не bf16; `head_dim` не 64/128/256; мультимодальный M-RoPE; не CUDA.
- **Симптом:** в логе `Failed to load JIT fused_qk_norm_rope kernel: …`. **Причина:** JIT-модуль не собрался (нет тулчейна, несовместимая версия). **Решение:** флаг можно снять, поведение и так уже обычное.
- **Симптом:** после включения TPOT не улучшился или ухудшился. **Причина:** потеря fused-записи KV перевесила экономию.
- **Проверка:** дамп `server_args=` при старте показывает флаг; предупреждения о неприменимости печатаются при загрузке модели, по одному на неподходящий слой.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --dtype bfloat16 --enable-fused-qk-norm-rope
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-235B-A22B --dtype bfloat16 --enable-fused-qk-norm-rope --tp-size 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/models/qwen3_moe.py`
- `sglang/python/sglang/srt/models/mellum.py`
- `sglang/python/sglang/kernels/ops/attention/fused_qknorm_rope.py`
