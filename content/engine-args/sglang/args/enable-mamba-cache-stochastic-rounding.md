---
schema: 1
engine: sglang
primaryName: "--enable-mamba-cache-stochastic-rounding"
title: "--enable-mamba-cache-stochastic-rounding"
summary: Включает несмещенное (стохастическое) округление при записи fp16 SSM-состояний, чтобы рекуррентность не накапливала систематическую ошибку на длинных генерациях. Требует `--mamba-ssm-dtype float16`, CUDA и — на Triton-бэкенде — SM100.
group: exec.mamba
related:
  - --mamba-ssm-dtype
  - --mamba-backend
  - --mamba-cache-philox-rounds
  - --max-mamba-cache-size
  - --mamba-full-memory-ratio
---

# --enable-mamba-cache-stochastic-rounding

## Кратко

Рекуррентное состояние обновляется на каждом токене, и ошибка округления не «размывается», а копится вдоль последовательности. В fp16 обычное округление к ближайшему смещено систематически, поэтому на длинных генерациях состояние уползает. Стохастическое округление делает ошибку несмещенной в среднем: результат округляется вверх или вниз с вероятностью, пропорциональной остатку. Флаг существует ровно для того, чтобы можно было пользоваться дешевым fp16-состоянием (вдвое меньше пул) без деградации на длинных ответах.

Ограничений три, и все проверяются на старте: тип состояния должен быть ровно `float16`, платформа — CUDA, а на `--mamba-backend triton` карта должна быть SM100 (Blackwell), потому что ядро использует PTX-инструкцию `cvt.rs.f16x2.f32`.

## Оригинальная справка

```text
Enable stochastic rounding when writing FP16 Mamba SSM cache states. Requires --mamba-ssm-dtype float16 and CUDA. With --mamba-backend triton, requires SM100.
```

## Паспорт аргумента

- Флаги: `--enable-mamba-cache-stochastic-rounding`
- Группа: `exec.mamba`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг задан / не задан
- Значение по умолчанию: `false`
- Эффективное значение: совпадает с заданным; движок не включает округление сам ни при каких условиях
- Где объявлен: `ServerArgs.enable_mamba_cache_stochastic_rounding`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_mamba_backend` — три проверки) → создание backend'а `selective_state_update` → каждая запись SSM-состояния в decode

## Что меняет в движке

Флаг передается в конструктор backend'а `selective_state_update` (`ssu_dispatch.py`) и оттуда — в ядро:

- **Triton**: компиляционный флаг `USE_RS_ROUNDING=True` в `mamba_ssm.py`; число раундов Philox берется из `--mamba-cache-philox-rounds`. Ядро дополнительно проверяет, что `state.dtype` равен `torch.float16`.
- **FlashInfer**: на каждый вызов генерируется `rand_seed` (`torch.randint(0, 2**32, (1,), device=state.device)`), а число раундов при нуле становится 10.

Проверки на старте (`_handle_mamba_backend`), в порядке выполнения:

1. `mamba_ssm_dtype != "float16"` → `ValueError: Stochastic rounding for the Mamba SSM cache requires --mamba-ssm-dtype float16, got …`;
2. платформа не CUDA → `ValueError: … is only supported on NVIDIA CUDA platforms.`;
3. `--mamba-backend triton` и не SM100 → `ValueError: … with --mamba-backend triton requires SM100 with CUDA >= 12.8 because it uses the cvt.rs.f16x2.f32 PTX instruction. On H100/SM90, run with --mamba-backend flashinfer --mamba-ssm-dtype float16, or disable …`;
4. при `--mamba-backend flashinfer` сообщение о недоступности модуля `flashinfer.mamba` дополняется требованием fp16-состояния.

Область действия — mamba2-слои (`MambaMixer2`): NemotronH, FalconH1, GraniteMoeHybrid и их производные. GDN- и KDA-ядра линейного внимания через этот флаг округление не получают.

Побочный эффект, который стоит держать в голове: с включенным округлением одинаковые запросы перестают давать побитово одинаковые состояния, потому что округление опирается на случайный поток. Для воспроизводимости используйте `float32` или `bfloat16`, а не fp16 с округлением.

## Значения и формат

- Флаг без значения; парной формы `--no-…` нет.
- Не задан — записи fp16 округляются обычным образом (к ближайшему).
- Задан без `--mamba-ssm-dtype float16` — старт падает, а не «включается частично».
- На карте Ampere/Ada (в том числе RTX A5000 из квалифицированного профиля arriero, SM86) путь Triton недоступен; остается только `--mamba-backend flashinfer` при наличии модуля `flashinfer.mamba`.

## Когда использовать

- Когда пул состояний ограничивает конкурентность, вы уже перешли на 16-битное состояние и наблюдаете деградацию именно на длинных генерациях (повторы, распад связности после нескольких тысяч токенов) — при коротких ответах эффект незаметен.
- Как альтернативу: если карта не SM100 и FlashInfer-модуля нет, выбирайте `--mamba-ssm-dtype bfloat16` — тот же выигрыш по памяти, больше динамический диапазон, никаких требований к железу.
- Не включать «на всякий случай»: это дополнительная работа в самом горячем ядре и потеря воспроизводимости.
- Не сочетать с задачами, где нужна побитовая повторяемость ответов.

## Влияние на производительность и память

- VRAM: не меняет. Экономию дает сам `--mamba-ssm-dtype float16`, а флаг только делает ее безопасной.
- RAM хоста: не влияет.
- Время старта: у Triton меняется ключ компиляции ядра — первый decode-шаг компилируется заново.
- Latency decode: округление выполняется на каждой записи состояния каждым mamba-слоем каждый токен; стоимость масштабируется числом раундов Philox.
- Качество: главная цель флага. Убирает систематический дрейф состояния, характерный для длинных последовательностей в fp16.

## Взаимодействие с другими аргументами

- `--mamba-ssm-dtype`: обязателен `float16`; любое другое значение (включая незаданное, которое разрешается в `float32`) отвергает старт.
- `--mamba-backend`: `triton` требует SM100; `flashinfer` требует модуль `flashinfer.mamba` и снимает требование к поколению карты.
- `--mamba-cache-philox-rounds`: качество и цена потока случайных чисел; при `0` берется дефолт бэкенда (у FlashInfer — 10).
- `--max-mamba-cache-size` / `--mamba-full-memory-ratio`: контекст, ради которого вообще берут fp16-состояние — вдвое больше слотов при том же бюджете.

## Типовые проблемы и диагностика

- `ValueError: Stochastic rounding for the Mamba SSM cache requires --mamba-ssm-dtype float16, got None.` — забыли задать тип состояния явно.
- `ValueError: … with --mamba-backend triton requires SM100 with CUDA >= 12.8 …` — карта старше Blackwell. Решение прямо в тексте ошибки: `--mamba-backend flashinfer`.
- `ValueError: FlashInfer mamba module not available … Stochastic rounding with --mamba-backend flashinfer requires FlashInfer Mamba and --mamba-ssm-dtype float16.` — FlashInfer собран без mamba-модуля.
- `ValueError: … is only supported on NVIDIA CUDA platforms.` — запуск на CPU/ROCm/NPU.
- Ответы перестали быть воспроизводимыми — это ожидаемое следствие; для повторяемости откажитесь от fp16-состояния.
- Что смотреть в логе: `enable_mamba_cache_stochastic_rounding=true` и `mamba_ssm_dtype='float16'` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-ssm-dtype float16 --enable-mamba-cache-stochastic-rounding
```

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-backend flashinfer --mamba-ssm-dtype float16 --enable-mamba-cache-stochastic-rounding --mamba-cache-philox-rounds 10
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/kernels/ops/mamba/triton_ops/ssu_dispatch.py`
- `sglang/python/sglang/kernels/ops/mamba/triton_ops/mamba_ssm.py`
- `sglang/python/sglang/srt/configs/mamba_utils.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md` (квалифицированный профиль хоста)
