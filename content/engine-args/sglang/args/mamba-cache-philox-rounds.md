---
schema: 1
engine: sglang
primaryName: "--mamba-cache-philox-rounds"
title: "--mamba-cache-philox-rounds"
summary: Число раундов генератора Philox для стохастического округления fp16-записей SSM-кеша. Имеет смысл только вместе с `--enable-mamba-cache-stochastic-rounding`; `0` означает «дефолт бэкенда» и трактуется Triton и FlashInfer по-разному.
group: exec.mamba
related:
  - --enable-mamba-cache-stochastic-rounding
  - --mamba-ssm-dtype
  - --mamba-backend
  - --max-mamba-cache-size
---

# --mamba-cache-philox-rounds

## Кратко

Стохастическое округление требует источника псевдослучайных чисел на каждую записываемую компоненту состояния; SGLang использует счетчиковый генератор Philox прямо в ядре. Число раундов — это компромисс между качеством потока случайных чисел и стоимостью его получения. Аргумент читается только тогда, когда включено `--enable-mamba-cache-stochastic-rounding`: без него значение доезжает до ядра, но ветка округления не активна. Значение `0` — не «выключено», а «взять дефолт бэкенда».

## Оригинальная справка

```text
Number of Philox rounds to use for stochastic rounding of FP16 Mamba SSM cache writes. Triton uses the Triton default when set to 0; FlashInfer uses 10 rounds when set to 0.
```

## Паспорт аргумента

- Флаги: `--mamba-cache-philox-rounds`
- Группа: `exec.mamba`
- Тип значения: int
- Допустимые значения: неотрицательное целое; отрицательное отвергается на старте
- Значение по умолчанию: `0`
- Эффективное значение: `0` не подменяется в `ServerArgs`, а разворачивается уже в бэкенде: Triton передает его в ядро как `PHILOX_ROUNDS=0` и использует собственный дефолт Triton, FlashInfer подставляет `10` (`philox_rounds=self._cache_philox_rounds or 10`)
- Где объявлен: `ServerArgs.mamba_cache_philox_rounds`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверка знака в `_handle_mamba_backend`) → создание backend'а `selective_state_update` при инициализации scheduler'а → каждый decode-шаг mamba2-слоя, если округление включено

## Что меняет в движке

Значение сохраняется в объекте backend'а (`TritonSSUBackend` / `FlashInferSSUBackend` в `sglang/python/sglang/kernels/ops/mamba/triton_ops/ssu_dispatch.py`) и передается в ядро `selective_state_update` вместе с флагом `enable_stochastic_rounding`:

- **Triton** — параметр компиляции `PHILOX_ROUNDS`; ветка округления в `mamba_ssm.py` включается макросом `USE_RS_ROUNDING`. При `0` берется дефолтное число раундов Triton.
- **FlashInfer** — параметр `philox_rounds`, плюс на каждый вызов генерируется `rand_seed` через `torch.randint(0, 2**32, (1,), device=state.device)`. При `0` подставляется 10.

Поскольку значение у Triton участвует в компиляции ядра, его изменение приводит к новой компиляции при первом decode-шаге — это видно как задержка на первом запросе, а не как ошибка.

Область действия ровно та же, что у `--mamba-backend`: mamba2-слои (`MambaMixer2`) моделей NemotronH, FalconH1, GraniteMoeHybrid. GDN- и KDA-ядра линейного внимания собственного стохастического округления через этот аргумент не получают.

## Значения и формат

- `0` — дефолт бэкенда (Triton: свой; FlashInfer: 10). Это значение по умолчанию и разумный выбор в большинстве случаев.
- Положительное целое задает число раундов явно. Меньше раундов — быстрее и хуже статистические свойства потока; больше — дороже.
- Отрицательное значение отвергается на старте: `ValueError: --mamba-cache-philox-rounds must be non-negative.`
- Без `--enable-mamba-cache-stochastic-rounding` значение никак не проявляется: ядро компилируется с `USE_RS_ROUNDING=False`.

## Когда использовать

- Трогать только после того, как стохастическое округление уже включено и подтверждено, что оно помогает: сначала `--enable-mamba-cache-stochastic-rounding`, потом раунды.
- Уменьшать число раундов, если профилирование показывает заметный вклад ядра `selective_state_update` в decode-шаг и вы готовы проверить качество генерации на своей задаче.
- Не подбирать значение «на глаз» без замера: разница между дефолтом бэкенда и явными 6–10 раундами на большинстве нагрузок неразличима.
- Не использовать как способ выключить округление: для этого просто не задавайте `--enable-mamba-cache-stochastic-rounding`.

## Влияние на производительность и память

- VRAM: не влияет — раунды Philox не требуют буферов, генератор счетчиковый.
- RAM хоста: не влияет.
- Время старта: у Triton меняет ключ компиляции ядра, то есть первый decode-шаг с новым значением компилируется заново.
- Latency decode: линейно по числу раундов в той части ядра, что отвечает за округление; относительно всей работы decode-шага вклад невелик, но на mamba2-моделях этот код выполняется каждым слоем каждый токен.
- Качество: слишком малое число раундов ухудшает независимость случайных величин между компонентами состояния, из-за чего округление перестает быть несмещенным на практике — а именно в несмещенности его смысл.

## Взаимодействие с другими аргументами

- `--enable-mamba-cache-stochastic-rounding`: единственный флаг, при котором значение вообще что-то делает.
- `--mamba-backend`: определяет, во что превращается `0` (дефолт Triton или 10 у FlashInfer) и генерируется ли отдельный `rand_seed` на вызов.
- `--mamba-ssm-dtype float16`: обязательное условие для округления, а значит и для этого аргумента.

## Типовые проблемы и диагностика

- `ValueError: --mamba-cache-philox-rounds must be non-negative.` — задано отрицательное значение.
- Значение задано, а поведение не изменилось — не включено `--enable-mamba-cache-stochastic-rounding` либо модель не mamba2 (GDN/KDA-путь этот аргумент не читает).
- Первый запрос после смены значения заметно медленнее — перекомпиляция Triton-ядра; на последующих запросах эффекта нет.
- Что смотреть в логе: принятое значение `mamba_cache_philox_rounds=` в дампе `server_args=`; отдельной строки о числе раундов движок не печатает.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-ssm-dtype float16 --enable-mamba-cache-stochastic-rounding --mamba-cache-philox-rounds 6
```

```bash
python -m sglang.launch_server --model-path /models/Nemotron-H-8B --mamba-backend flashinfer --mamba-ssm-dtype float16 --enable-mamba-cache-stochastic-rounding --mamba-cache-philox-rounds 10
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/kernels/ops/mamba/triton_ops/ssu_dispatch.py`
- `sglang/python/sglang/kernels/ops/mamba/triton_ops/mamba_ssm.py`
- `sglang/python/sglang/srt/layers/attention/mamba/mamba.py`
